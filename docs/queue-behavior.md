# Queue behavior requirements

Updated October 17, 2026. This defines the intended queue behavior.

## Shared behavior

- Queues support pictures, videos, audio, and other playable items.
- A queue comes from the view where playback started, with that view's active
  filters and sorting applied.
- The playback URL must encode enough source context to rebuild the queue after
  a refresh or direct load, even when the queue cache is missing. This includes
  the source view/location, filters, sorting, playback entry method (item click,
  Play all, or Shuffle), and the current item/queue position.
- The URL must also encode the return destination. Back returns to the originating
  view: starting in a library returns to that library; starting in Recent returns
  to Recent. Recovery must not depend on cached navigation state.
- In aggregated views such as Recent, provide a menu action to go to the item's
  actual location.

## Clicking an item

- Clicking an item queues all playable items in the current view, using its
  filters and sort order.
- Start at the clicked item's position in that queue. For example, clicking the
  second item starts at **2 / total**, rather than moving it to the front.
- When clicking an item in Recent, the queue contains the items from Recent,
  rather than items from the clicked item's library or folder.

## Play all

- Play everything in the current location/view with the active filters and
  sorting applied.
- Always start at **1 / total**, with the first item in that ordering.
- Start playback as soon as the first item is known; do not wait for the entire
  queue to be resolved.
- Resolve the remaining queue while playback is underway. The URL must retain
  enough context to rebuild it after refresh, including the Play all entry method.

## Shuffle

- Use the same current location/view and active filters as Play all, but shuffle
  all eligible items.
- Pick a random first item and begin playback quickly, then randomize the rest
  of the queue while playback is underway. Do not wait for the entire shuffled
  queue before starting playback.
- Always start at **1 / total**. Here, item 1 is the randomly selected item,
  rather than the first item in the view's normal sort order.
- The URL must retain the Shuffle entry method and enough context to rebuild
  the queue after refresh, including when the queue cache is missing.

## Acceptance examples

| Entry point | Expected behavior |
| --- | --- |
| Click the second item in a filtered, sorted library view | Start at 2 / total; queue follows that view's filters and sorting; Back returns to that library view. |
| Click an item in Recent | Queue comes from Recent; Back returns to Recent; a menu action opens the item's actual location. |
| Play all in a filtered view | Start at 1 / total with the first sorted item, before the full queue has resolved. |
| Shuffle in a filtered view | Start at 1 / total with a random eligible item, then shuffle the remaining items. |
| Refresh or directly load a playback URL with no queue cache | Recover the source, filters, sorting, entry method, current playback position, and return destination from the URL and rebuild the queue. |

## Implementation and regression checks

- Online item clicks, Play all, and Shuffle use the URL's versioned `queueSource`
  description. It records the view, filters, sorting, entry method, and return
  URL. The current item remains in `path`; its index is derived from the rebuilt
  queue. Shuffle also records its seed and original first item so advancing or
  refreshing does not rotate the new current item back to position 1.
- Watch resolves the complete queue independently of media startup. For paged
  folder Shuffle, the library first samples a random page from the full source,
  rather than limiting the random first item to loaded cards.
- The URL preserves an item's access time before playing it when ordering by
  Last opened or using Recent. This prevents playback activity from changing its
  queue position on refresh. New uses the queue's start time as its time-window
  reference.
- Playback has one shared, user-scoped session above the library and Watch.
  Clicking audio, Play all, and Shuffle use the mini player whenever the current
  item is audio. Images and videos use Watch. Mixed queues retain their exact
  order, selected index, shuffle seed, and original anchor across both views.
- The mini player remains mounted while browsing. It starts the first audio
  immediately and resolves the complete filtered queue in the background. Queue
  loading failures show a retry action; a track that ends while loading waits
  for the queue before auto-advancing.
- Video/image to audio replaces Watch with the return browsing view and starts
  the mini player. Subsequent automatic changes replace the playback history
  entry rather than building a history of played tracks. Back restores the
  browsing snapshot, including filters, sorting, and scroll position.
- Watch URLs retain queueSource for cache-free online recovery. Mini-player
  sessions persist their current item, queue, source, return URL and progress in
  tab-local storage scoped to the signed-in account. Reload restores audio
  paused; an immediate handoff from Watch preserves play intent.
- Both players persist progress. Outgoing player cleanup must never overwrite
  the next item's progress, and resolving queue metadata must never seek or
  restart the active audio.
- Run `node --test tests/playback-queue.test.cjs tests/playback-session.test.cjs` for source filtering, sorting,
  startup, cache-free loading, URL navigation, and production entry-function
  regressions. Run `npm run test:unit` and `npm run build` for broader checks.
- Final browser validation requires the running frontend to serve a release
  whose source stamp matches the current checkout. Use the existing signed-in
  browser session and exercise audio-first playback plus both directions of a
  mixed-media queue transition.
