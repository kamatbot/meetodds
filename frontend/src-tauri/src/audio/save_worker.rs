//! Shared close-and-drain protocol for bounded production queues and compatibility callers.
use std::future::Future;
use tokio::sync::{mpsc, oneshot};

enum Receiver<T> { Bounded(mpsc::Receiver<T>), Unbounded(mpsc::UnboundedReceiver<T>) }
impl<T> Receiver<T> {
    fn close(&mut self) { match self { Self::Bounded(receiver) => receiver.close(), Self::Unbounded(receiver) => receiver.close() } }
    async fn recv(&mut self) -> Option<T> { match self { Self::Bounded(receiver) => receiver.recv().await, Self::Unbounded(receiver) => receiver.recv().await } }
}
async fn drain<T, F, Fut>(mut receiver: Receiver<T>, mut shutdown: oneshot::Receiver<()>, mut write: F) -> Result<(), String>
where F: FnMut(T) -> Fut, Fut: Future<Output = Result<(), String>> {
    let mut closing = false;
    loop {
        let item = if closing { receiver.recv().await } else {
            tokio::select! {
                biased;
                _ = &mut shutdown => { receiver.close(); closing = true; continue; }
                next = receiver.recv() => next,
            }
        };
        match item { Some(item) => write(item).await?, None => return Ok(()) }
    }
}
pub async fn drain_until_closed<T, F, Fut>(receiver: mpsc::UnboundedReceiver<T>, shutdown: oneshot::Receiver<()>, write: F) -> Result<(), String>
where F: FnMut(T) -> Fut, Fut: Future<Output = Result<(), String>> {
    drain(Receiver::Unbounded(receiver), shutdown, write).await
}
pub async fn drain_bounded_until_closed<T, F, Fut>(receiver: mpsc::Receiver<T>, shutdown: oneshot::Receiver<()>, write: F) -> Result<(), String>
where F: FnMut(T) -> Fut, Fut: Future<Output = Result<(), String>> {
    drain(Receiver::Bounded(receiver), shutdown, write).await
}
#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};
    #[tokio::test]
    async fn shutdown_drains_every_already_accepted_item() {
        let (sender, receiver) = mpsc::unbounded_channel(); let (shutdown, stopped) = oneshot::channel();
        for n in 0..100 { sender.send(n).unwrap(); } shutdown.send(()).unwrap();
        let written = Arc::new(Mutex::new(Vec::new())); let output = written.clone();
        drain_until_closed(receiver, stopped, move |n| { let output = output.clone(); async move { tokio::task::yield_now().await; output.lock().unwrap().push(n); Ok(()) } }).await.unwrap();
        assert_eq!(*written.lock().unwrap(), (0..100).collect::<Vec<_>>()); assert!(sender.send(101).is_err());
    }
    #[tokio::test]
    async fn an_owner_drop_also_closes_and_drains() {
        let (sender, receiver) = mpsc::unbounded_channel(); let (shutdown, stopped) = oneshot::channel();
        sender.send(7).unwrap(); drop(shutdown); let mut result = Vec::new();
        drain_until_closed(receiver, stopped, |n| { result.push(n); async { Ok(()) } }).await.unwrap(); assert_eq!(result, vec![7]);
    }
    #[tokio::test]
    async fn a_writer_failure_is_returned_not_disguised_as_success() {
        let (sender, receiver) = mpsc::unbounded_channel(); let (_shutdown, stopped) = oneshot::channel(); sender.send(1).unwrap();
        assert_eq!(drain_until_closed(receiver, stopped, |_| async { Err("disk unavailable".to_string()) }).await.unwrap_err(), "disk unavailable");
        assert!(sender.send(2).is_err());
    }
    #[tokio::test]
    async fn bounded_queue_rejects_excess_and_still_drains_accepted_frames() {
        let (sender, receiver) = mpsc::channel(2); let (shutdown, stopped) = oneshot::channel();
        sender.try_send(1).unwrap(); sender.try_send(2).unwrap(); assert!(sender.try_send(3).is_err());
        shutdown.send(()).unwrap(); let mut written = Vec::new();
        drain_bounded_until_closed(receiver, stopped, |n| { written.push(n); async { Ok(()) } }).await.unwrap();
        assert_eq!(written, vec![1, 2]); assert!(sender.try_send(4).is_err());
    }
}
