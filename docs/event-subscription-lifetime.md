# Native event subscription lifetime

The shared core event registry is used by the Solid and React adapters. An
unsubscribe handle has authority over one exact node/type/phase registration,
not over a later replacement in that slot.

A live handle owns a revocable subscription cell. On unsubscribe, replacement,
registered-node removal or window/application shutdown, the registry clears
both its listener invocation and the cell's removal callback **before** it
aborts the registration signal. A retained revoked handle therefore has no
strong path through that cell to the listener, registry, node or controller.
An already-prepared dispatch plan also loses its invocation reference when its
binding is revoked. User code that separately retains a listener, event or
uncooperative promise still owns those references; cancellation does not undo
its side effects or forcibly destroy arbitrary promises.

The typed invocation wrapper and returned handle are created outside the
registration/removal scope. This separation prevents a shared closure scope
from silently retaining the original listener. Listener functions keep their
unbound receiver; the internal binding is never supplied as `this`.

`tests/core/event-binding-lifetime.test.ts` exercises all four revocation paths,
queued delivery, abort-handler reentrancy, a waiting listener's cancellation and
late rejection, and the invocation receiver. Six revocation controls fail on
the prior implementation because the cancelled binding still contains its
listener invocation. The original source, native-input and Solid/React
collection oracles remain mandatory and unchanged.

This correction removes an explicit strong-reference path. It does not, by
itself, attribute the independent final-root collection observation in #287 or
the Linux first-window startup deadline in #296. Only exact-source native and
AOT platform validation qualifies those environments.
