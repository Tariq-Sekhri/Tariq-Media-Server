export default function QueueReadout({ loading, index, total }: { loading: boolean; index: number; total: number }) {
  return <span className="watch-readout-queue" role="status" aria-label={loading ? "Loading queue" : undefined}>
    {loading ? <span className="watch-queue-loading"><i aria-hidden="true" />Loading…</span> : `${Math.max(index, 0) + 1} of ${total}`}
  </span>;
}
