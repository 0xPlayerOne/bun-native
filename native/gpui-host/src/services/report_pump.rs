//! Native reports reach a service on the UI thread without an ownership
//! cycle.
//!
//! A native source (a notification center, a hot-key handler) calls back on
//! its own threads through a sink that holds the channel's sender, and the
//! service owns that source. If the task draining the channel held the
//! service strongly, service -> source -> sender -> channel -> task -> service
//! would keep an idle, connected service alive after its owner let it go.
//! Here the task holds the service weakly, and the service owns a
//! [`ReportLink`] that closes the channel when the service stops or is
//! dropped. The task then ends even while a native callback still holds a
//! sender clone; that callback's later send fails and is ignored.

use async_channel::{Receiver, Sender};
use std::rc::{Rc, Weak};

/// The service's end of a report channel: closing it (explicitly, or by
/// dropping it with the service) ends the [`pump`].
pub(crate) struct ReportLink<T>(Receiver<T>);

impl<T> ReportLink<T> {
    pub(crate) fn close(&self) {
        self.0.close();
    }
}

impl<T> Drop for ReportLink<T> {
    fn drop(&mut self) {
        self.close();
    }
}

/// A bounded report channel: the sender for the native sink, the link for
/// the service and the receiver for [`pump`].
pub(crate) fn channel<T>(capacity: usize) -> (Sender<T>, ReportLink<T>, Receiver<T>) {
    let (sender, receiver) = async_channel::bounded(capacity);
    (sender, ReportLink(receiver.clone()), receiver)
}

/// Deliver each report to the service while it is alive. Returns when the
/// link closes, every sender is gone, or the service has been dropped.
pub(crate) async fn pump<S, T>(
    service: Weak<S>,
    reports: Receiver<T>,
    mut deliver: impl FnMut(Rc<S>, T),
) {
    while let Ok(report) = reports.recv().await {
        let Some(service) = service.upgrade() else {
            break;
        };
        deliver(service, report);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use futures_lite::future::{block_on, poll_once};
    use std::cell::RefCell;

    /// A service shaped like the macOS ones: it owns its native source (here
    /// the sink's sender) and its link.
    struct Service {
        delivered: RefCell<Vec<u32>>,
        _source: Sender<u32>,
        _link: ReportLink<u32>,
    }

    fn connected() -> (Rc<Service>, Sender<u32>, Receiver<u32>) {
        let (sender, link, receiver) = channel(4);
        let service = Rc::new(Service {
            delivered: RefCell::new(Vec::new()),
            _source: sender.clone(),
            _link: link,
        });
        (service, sender, receiver)
    }

    #[test]
    fn a_connected_idle_service_is_freed_and_its_worker_completes() {
        // `outstanding` stands for a native callback still holding a sink.
        let (service, outstanding, receiver) = connected();
        let weak = Rc::downgrade(&service);
        let mut worker = Box::pin(pump(weak.clone(), receiver, |_, _| {}));
        assert!(
            block_on(poll_once(worker.as_mut())).is_none(),
            "idle worker waits"
        );
        // The waiting worker does not own the service.
        assert_eq!(Rc::strong_count(&service), 1);
        drop(service);
        assert_eq!(
            weak.strong_count(),
            0,
            "the owner released the last reference"
        );
        // The link closed with the service, so the worker ends at once even
        // though a sender is still outstanding.
        assert!(block_on(poll_once(worker.as_mut())).is_some());
        assert!(outstanding.is_closed());
        assert!(outstanding.try_send(1).is_err());
    }

    #[test]
    fn reports_reach_a_live_service_until_the_link_closes() {
        let (service, outstanding, receiver) = connected();
        let mut worker = Box::pin(pump(
            Rc::downgrade(&service),
            receiver,
            |service, report| {
                service.delivered.borrow_mut().push(report);
            },
        ));
        outstanding.try_send(7).unwrap();
        outstanding.try_send(8).unwrap();
        assert!(block_on(poll_once(worker.as_mut())).is_none());
        assert_eq!(*service.delivered.borrow(), [7, 8]);
        // Shutdown closes the link while the service is still owned.
        service._link.close();
        assert!(block_on(poll_once(worker.as_mut())).is_some());
        assert!(outstanding.try_send(9).is_err());
        assert_eq!(*service.delivered.borrow(), [7, 8]);
        assert_eq!(Rc::strong_count(&service), 1);
    }

    #[test]
    fn a_report_queued_before_the_service_dropped_is_not_delivered() {
        let (sender, link, receiver) = channel(4);
        let service = Rc::new(RefCell::new(0_u32));
        let mut worker = Box::pin(pump(Rc::downgrade(&service), receiver, |service, _| {
            *service.borrow_mut() += 1;
        }));
        sender.try_send(1).unwrap();
        drop(service);
        // The channel is still open (the link is held apart here); the
        // worker stops at the first report it cannot deliver.
        assert!(block_on(poll_once(worker.as_mut())).is_some());
        drop(link);
    }
}
