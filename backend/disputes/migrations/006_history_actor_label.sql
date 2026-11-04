-- Copied from the agent principal at write time so disputes never reads auth (ADR-071); existing grants and guard cover it.
alter table dispute_status_history add column actor_label text
  constraint dispute_status_history_actor_label_check check (
    actor_label is null
    or (actor_type = 'AGENT' and char_length(actor_label) between 1 and 80 and btrim(actor_label) <> ''));
