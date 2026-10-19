---
description: Extract every contestable claim from the specs and verify it against primary sources
---

Verify: `$ARGUMENTS` (default: all of `docs/`).

## 1. Extract

List every contestable claim — anything that is a number, a name, or a comparison:

- prices, rate limits, quotas, free-tier boundaries
- model IDs, package names, SDK method names, version numbers
- "X is faster/cheaper than Y", cost projections, performance figures
- platform constraints ("works in Expo Go", "runs on the free tier")

## 2. Verify

Against the **vendor's own page**. Not blog aggregators — they are routinely months stale and
confidently wrong. Official docs, the pricing page, npm, the repo README.

**Check you are verifying the right product surface.** A vendor often has two products with similar
names and different prices (a developer API and a cloud-platform offering, for instance). Verifying
the wrong one produces a number that is real, cited, and inapplicable.

**Recompute every derived figure yourself and show the arithmetic in the doc.** A cost estimate
carried forward from an earlier assumption is the most common silent error: it looks precise, was
never calculated, and nobody re-checks it.

## 3. Correct and report

- Fix the doc. Add `verified against <url> on <date>` next to anything volatile, plus an expiry
  note if the vendor has announced a change.
- **Report what was wrong, plainly and specifically.** "The cost estimate was ~15x low because it
  assumed a pricing tier that no longer exists" — not a silent edit.
- Where a claim cannot be verified, mark it in the doc as unverified rather than leaving it looking
  settled.

## 4. Sweep for internal consistency

Claims corrected in one place go stale in another. After correcting, grep for the old figure and
for prose that summarises it ("~10x cheaper", "roughly free at this scale"). A corrected table
sitting next to an uncorrected sentence is worse than neither.
