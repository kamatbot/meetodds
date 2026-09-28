//! Real on-device Apple Translation check through the Rust wrapper. Never installs anything.
//! Translation answers through the main dispatch queue (the app's event loop services it),
//! so the main thread pumps a run loop while the check runs on a worker thread.
use app_lib::apple_translation::{self, Availability};
use std::time::Instant;
use tokio_util::sync::CancellationToken;

const SENTENCES: [&str; 5] = [
    "Buenos días a todos.",
    "¿Podemos revisar el presupuesto del próximo trimestre?",
    "El cliente necesita el informe antes del viernes.",
    "Creo que deberíamos lanzar la versión beta en marzo.",
    "Gracias, nos vemos la semana que viene.",
];

async fn check() {
    for (source, target) in [("es", "en"), ("en", "es"), ("hi", "en")] {
        let (status, _) = apple_translation::prepare(source, target, false).await.unwrap();
        println!("{source}->{target}: {status:?}");
    }
    let cancel = CancellationToken::new();
    let (status, _) = apple_translation::prepare("es", "en", false).await.unwrap();
    if status != Availability::Installed {
        let error = apple_translation::translate("es", "en", SENTENCES[0], &cancel).await.unwrap_err();
        println!("es->en not installed; translate returns: {error}");
        return;
    }
    let ms = |started: Instant| (started.elapsed().as_secs_f64() * 10_000.0).round() / 10.0;
    let mut fresh = Vec::new();
    for sentence in SENTENCES {
        apple_translation::reset_sessions();
        let started = Instant::now();
        assert!(!apple_translation::translate("es", "en", sentence, &cancel).await.unwrap().is_empty());
        fresh.push(ms(started));
    }
    let mut reused = Vec::new();
    for sentence in SENTENCES {
        let started = Instant::now();
        assert!(!apple_translation::translate("es", "en", sentence, &cancel).await.unwrap().is_empty());
        reused.push(ms(started));
    }
    // Translated text is deliberately not printed.
    println!("es->en new session per request (ms): {fresh:?}");
    println!("es->en reused session (ms):          {reused:?}");
    apple_translation::reset_sessions();
    let started = Instant::now();
    let (_, warmed) = apple_translation::prepare("es", "en", true).await.unwrap();
    let prepare_ms = ms(started);
    let started = Instant::now();
    apple_translation::translate("es", "en", SENTENCES[1], &cancel).await.unwrap();
    println!("prepare+warm {prepare_ms} ms (warmed={warmed}), first caption after warm {} ms", ms(started));
}

#[cfg(target_os = "macos")]
fn main() {
    extern "C" {
        fn CFRunLoopRunInMode(mode: *const std::ffi::c_void, seconds: f64, once: u8) -> i32;
        static kCFRunLoopDefaultMode: *const std::ffi::c_void;
    }
    let worker = std::thread::spawn(|| tokio::runtime::Runtime::new().unwrap().block_on(check()));
    while !worker.is_finished() {
        unsafe { CFRunLoopRunInMode(kCFRunLoopDefaultMode, 0.05, 0) };
    }
    worker.join().unwrap();
}

#[cfg(not(target_os = "macos"))]
fn main() {
    println!("Apple Translation is macOS-only.");
}
