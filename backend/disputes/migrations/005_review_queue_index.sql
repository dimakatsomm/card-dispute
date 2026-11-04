-- Agent review queue (ADR-071): oldest open first with (created_at, id) keyset paging over both open statuses without a sort.
create index dispute_review_queue_idx on dispute (created_at, id) where status in ('SUBMITTED', 'UNDER_REVIEW');
