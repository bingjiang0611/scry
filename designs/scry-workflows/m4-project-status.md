# M4 project expression status

Implemented the reusable `project` grammar primitive at the general workflow expression layer.

- Ordinary arrays evaluate the value expression once per bound item, preserve order, retain unknown as unknown, and use existing batch/value bounds and collection provenance.
- Controlled collections read through the canonical control authority, preserve row keys/outcome evidence, save projected values in the value store, and retain nested collection authority on cold reads. Non-completed or unsettled rows are retained without evaluation.
- Parser, reference traversal, type inference, runtime evaluation, and focused persistence/recovery coverage are included.

Not claimed: the M4 batch template remains open. No Provider/Jev/Claude quality or real-account acceptance is included.
