//! A close-and-drain protocol, not a timed guess that disk writes have finished.
use std::future::Future;
use tokio::sync::{mpsc, oneshot};

pub async fn drain_until_closed<T, F, Fut>(
    mut receiver: mpsc::UnboundedReceiver<T>,
    mut shutdown: oneshot::Receiver<()>,
    mut write: F,
) -> Result<(), String>
where
    F: FnMut(T) -> Fut,
    Fut: Future<Output = Result<(), String>>,
{
    let mut closing = false;
    loop {
        let item = if closing {
            receiver.recv().await
        } else {
            tokio::select! {
                biased;
                _ = &mut shutdown => {
                    receiver.close();
                    closing = true;
                    continue;
                }
                next = receiver.recv() => next,
            }
        };
        match item {
            Some(item) => write(item).await?,
            None => return Ok(()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};

    #[tokio::test]
    async fn shutdown_drains_every_already_accepted_item() {
        let (sender, receiver) = mpsc::unbounded_channel();
        let (shutdown, stopped) = oneshot::channel();
        for n in 0..100 { sender.send(n).unwrap(); }
        shutdown.send(()).unwrap();
        let written = Arc::new(Mutex::new(Vec::new()));
        let output = written.clone();
        drain_until_closed(receiver, stopped, move |n| {
            let output = output.clone();
            async move { tokio::task::yield_now().await; output.lock().unwrap().push(n); Ok(()) }
        }).await.unwrap();
        assert_eq!(*written.lock().unwrap(), (0..100).collect::<Vec<_>>());
        assert!(sender.send(101).is_err());
    }

    #[tokio::test]
    async fn an_owner_drop_also_closes_and_drains() {
        let (sender, receiver) = mpsc::unbounded_channel();
        let (shutdown, stopped) = oneshot::channel();
        sender.send(7).unwrap(); drop(shutdown);
        let mut result = Vec::new();
        drain_until_closed(receiver, stopped, |n| { result.push(n); async { Ok(()) } }).await.unwrap();
        assert_eq!(result, vec![7]);
    }

    #[tokio::test]
    async fn a_writer_failure_is_returned_not_disguised_as_success() {
        let (sender, receiver) = mpsc::unbounded_channel();
        let (_shutdown, stopped) = oneshot::channel();
        sender.send(1).unwrap();
        let result = drain_until_closed(receiver, stopped, |_| async { Err("disk unavailable".to_string()) }).await;
        assert_eq!(result.unwrap_err(), "disk unavailable");
        assert!(sender.send(2).is_err());
    }
}
