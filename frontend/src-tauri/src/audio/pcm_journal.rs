//! Append-only, checksummed PCM journal. An append is acknowledged only after sync_data.
//! No Tauri, codecs, model or network dependency; compile its tests with rustc --test.
use std::fs::{File, OpenOptions};
use std::io::{self, Read, Write};
use std::path::Path;
use std::sync::OnceLock;

const MAGIC: &[u8; 8] = b"MODDSP01";
const HEADER_LEN: usize = 16;
const FRAME_LEN: usize = 16;
const MAX_FRAME_SECONDS: usize = 10;

fn invalid(message: &str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, message)
}
fn crc32(bytes: &[u8]) -> u32 {
    static TABLE: OnceLock<[u32; 256]> = OnceLock::new();
    let table = TABLE.get_or_init(|| {
        let mut table = [0_u32; 256];
        for (index, entry) in table.iter_mut().enumerate() {
            let mut crc = index as u32;
            for _ in 0..8 { crc = if crc & 1 != 0 { (crc >> 1) ^ 0xedb88320 } else { crc >> 1 }; }
            *entry = crc;
        }
        table
    });
    !bytes.iter().fold(!0_u32, |crc, byte| table[((crc ^ u32::from(*byte)) & 255) as usize] ^ (crc >> 8))
}

#[derive(Debug, Clone, PartialEq)]
pub struct JournalReceipt {
    pub sample_rate: u32,
    pub frames: u64,
    pub samples: u64,
    pub verified_bytes: u64,
    /// A truncated/corrupt suffix was discarded; all earlier verified frames remain usable.
    pub incomplete_tail: bool,
}
impl JournalReceipt {
    pub fn duration_seconds(&self) -> f64 { self.samples as f64 / f64::from(self.sample_rate) }
}

pub struct PcmJournal {
    file: File,
    sample_rate: u32,
    frames: u64,
    samples: u64,
    failed: bool,
}
impl PcmJournal {
    pub fn create(path: &Path, sample_rate: u32) -> io::Result<Self> {
        if !(8_000..=192_000).contains(&sample_rate) { return Err(invalid("Unsupported journal sample rate")); }
        // Never truncate a prior session, even when two generated meeting names collide.
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)] { use std::os::unix::fs::OpenOptionsExt; options.mode(0o600); }
        let mut file = options.open(path)?;
        let mut header = Vec::with_capacity(HEADER_LEN);
        header.extend_from_slice(MAGIC);
        header.extend_from_slice(&sample_rate.to_le_bytes());
        header.extend_from_slice(&1_u32.to_le_bytes());
        file.write_all(&header)?;
        file.sync_all()?;
        #[cfg(unix)]
        if let Some(parent) = path.parent() { File::open(parent)?.sync_all()?; }
        Ok(Self { file, sample_rate, frames: 0, samples: 0, failed: false })
    }
    pub fn append(&mut self, samples: &[f32], sample_rate: u32) -> io::Result<JournalReceipt> {
        if self.failed { return Err(invalid("Journal write previously failed; recover before writing again")); }
        if sample_rate != self.sample_rate { return Err(invalid("Journal sample rate changed during capture")); }
        if samples.len() > self.sample_rate as usize * MAX_FRAME_SECONDS { return Err(invalid("Journal frame exceeds capture budget")); }
        if samples.iter().any(|value| !value.is_finite()) { return Err(invalid("Non-finite audio sample")); }
        if samples.is_empty() { return Ok(self.receipt()); }
        let mut bytes = Vec::with_capacity(samples.len() * 4);
        for sample in samples { bytes.extend_from_slice(&sample.to_le_bytes()); }
        let mut header = Vec::with_capacity(FRAME_LEN);
        header.extend_from_slice(&self.frames.to_le_bytes());
        header.extend_from_slice(&(samples.len() as u32).to_le_bytes());
        header.extend_from_slice(&crc32(&bytes).to_le_bytes());
        let result = self.file.write_all(&header)
            .and_then(|_| self.file.write_all(&bytes))
            .and_then(|_| self.file.sync_data());
        if let Err(error) = result { self.failed = true; return Err(error); }
        self.frames += 1;
        self.samples += samples.len() as u64;
        Ok(self.receipt())
    }
    pub fn receipt(&self) -> JournalReceipt {
        JournalReceipt { sample_rate: self.sample_rate, frames: self.frames, samples: self.samples,
            verified_bytes: HEADER_LEN as u64 + self.frames * FRAME_LEN as u64 + self.samples * 4, incomplete_tail: false }
    }
}

/// Copy only the verified prefix to a PCM sink. Memory is bounded to one frame.
/// Corruption never causes later bytes to be mistaken for a valid frame boundary.
pub fn replay(path: &Path, output: &mut impl Write) -> io::Result<JournalReceipt> {
    let mut file = File::open(path)?;
    let mut header = [0_u8; HEADER_LEN];
    file.read_exact(&mut header)?;
    if &header[..8] != MAGIC { return Err(invalid("Unknown audio journal format")); }
    let rate = u32::from_le_bytes(header[8..12].try_into().unwrap());
    let channels = u32::from_le_bytes(header[12..16].try_into().unwrap());
    if !(8_000..=192_000).contains(&rate) || channels != 1 { return Err(invalid("Invalid audio journal configuration")); }
    let mut receipt = JournalReceipt { sample_rate: rate, frames: 0, samples: 0, verified_bytes: HEADER_LEN as u64, incomplete_tail: false };
    loop {
        let mut frame = [0_u8; FRAME_LEN];
        match file.read(&mut frame[..1])? { 0 => return Ok(receipt), _ => {} }
        if let Err(error) = file.read_exact(&mut frame[1..]) {
            if error.kind() != io::ErrorKind::UnexpectedEof { return Err(error); }
            receipt.incomplete_tail = true; return Ok(receipt);
        }
        let sequence = u64::from_le_bytes(frame[..8].try_into().unwrap());
        let count = u32::from_le_bytes(frame[8..12].try_into().unwrap()) as usize;
        let checksum = u32::from_le_bytes(frame[12..16].try_into().unwrap());
        if sequence != receipt.frames || count == 0 || count > rate as usize * MAX_FRAME_SECONDS {
            receipt.incomplete_tail = true; return Ok(receipt);
        }
        let mut bytes = vec![0_u8; count * 4];
        if let Err(error) = file.read_exact(&mut bytes) {
            if error.kind() != io::ErrorKind::UnexpectedEof { return Err(error); }
            receipt.incomplete_tail = true; return Ok(receipt);
        }
        if crc32(&bytes) != checksum || bytes.chunks_exact(4).any(|b| !f32::from_le_bytes(b.try_into().unwrap()).is_finite()) {
            receipt.incomplete_tail = true; return Ok(receipt);
        }
        output.write_all(&bytes)?;
        receipt.frames += 1;
        receipt.samples += count as u64;
        receipt.verified_bytes += (FRAME_LEN + bytes.len()) as u64;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};
    struct Temp(std::path::PathBuf);
    impl Temp {
        fn new() -> Self {
            static NEXT: AtomicU64 = AtomicU64::new(0);
            let path = std::env::temp_dir().join(format!("meetodds-journal-test-{}-{}-{}", std::process::id(),
                std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos(), NEXT.fetch_add(1, Ordering::Relaxed)));
            std::fs::create_dir(&path).unwrap(); Self(path)
        }
        fn file(&self) -> std::path::PathBuf { self.0.join("audio.pcmj") }
    }
    impl Drop for Temp { fn drop(&mut self) { let _ = std::fs::remove_dir_all(&self.0); } }
    #[test] fn checksum_has_a_known_vector() { assert_eq!(crc32(b"123456789"), 0xcbf43926); }
    #[test] fn acknowledged_frames_survive_close_and_reopen() {
        let temp = Temp::new(); let path = temp.file();
        let receipt = { let mut journal = PcmJournal::create(&path, 48_000).unwrap();
            journal.append(&[0.25; 24_000], 48_000).unwrap(); journal.append(&[-0.25; 12_000], 48_000).unwrap() };
        let mut output = Vec::new(); let recovered = replay(&path, &mut output).unwrap();
        assert_eq!(receipt, recovered); assert_eq!(recovered.duration_seconds(), 0.75); assert_eq!(output.len(), 36_000 * 4);
    }
    #[test] fn a_new_session_cannot_overwrite_existing_audio() {
        let temp = Temp::new(); let _first = PcmJournal::create(&temp.file(), 48_000).unwrap();
        assert_eq!(PcmJournal::create(&temp.file(), 48_000).err().unwrap().kind(), io::ErrorKind::AlreadyExists);
    }
    #[test] fn every_torn_suffix_keeps_all_previous_frames() {
        let temp = Temp::new(); let path = temp.file();
        let mut journal = PcmJournal::create(&path, 48_000).unwrap();
        let first = journal.append(&[0.5; 20], 48_000).unwrap(); journal.append(&[-0.5; 20], 48_000).unwrap(); drop(journal);
        let bytes = std::fs::read(&path).unwrap();
        for cut in first.verified_bytes as usize + 1..bytes.len() {
            let torn = temp.0.join("torn"); std::fs::write(&torn, &bytes[..cut]).unwrap();
            let receipt = replay(&torn, &mut io::sink()).unwrap();
            assert_eq!(receipt.samples, 20, "cut={cut}"); assert!(receipt.incomplete_tail);
        }
    }
    #[test] fn corruption_discards_the_suffix_not_the_verified_prefix() {
        let temp = Temp::new(); let path = temp.file(); let mut journal = PcmJournal::create(&path, 48_000).unwrap();
        journal.append(&[0.1; 10], 48_000).unwrap(); journal.append(&[0.2; 10], 48_000).unwrap(); drop(journal);
        let mut bytes = std::fs::read(&path).unwrap(); *bytes.last_mut().unwrap() ^= 1; std::fs::write(&path, bytes).unwrap();
        let result = replay(&path, &mut io::sink()).unwrap(); assert_eq!(result.samples, 10); assert!(result.incomplete_tail);
    }
    #[test] fn invalid_input_never_receives_an_acknowledgement() {
        let temp = Temp::new(); let mut journal = PcmJournal::create(&temp.file(), 48_000).unwrap();
        assert!(journal.append(&[f32::NAN], 48_000).is_err()); assert!(journal.append(&[0.1], 16_000).is_err());
        assert!(journal.append(&vec![0.0; 480_001], 48_000).is_err()); assert_eq!(journal.receipt().samples, 0);
    }
    #[test] fn replay_rejects_bad_configuration_before_allocating() {
        let temp = Temp::new(); std::fs::write(temp.file(), [0_u8; 16]).unwrap();
        assert!(replay(&temp.file(), &mut io::sink()).is_err());
    }
    #[test] fn failed_replay_sink_is_not_a_recovery_success() {
        struct Failing; impl Write for Failing { fn write(&mut self, _: &[u8]) -> io::Result<usize> { Err(io::Error::new(io::ErrorKind::Other, "full")) } fn flush(&mut self) -> io::Result<()> { Ok(()) } }
        let temp = Temp::new(); let mut journal = PcmJournal::create(&temp.file(), 48_000).unwrap(); journal.append(&[0.1], 48_000).unwrap();
        assert!(replay(&temp.file(), &mut Failing).is_err());
    }
}
