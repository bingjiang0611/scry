# M4 candidate-only batch migration draft status

Implemented the project-draft authoring slice:

- A shared generator emits an ordinary workflow using `replica`, `map`, per-item `replica` + scoped Agent + exact `check`, `filter`, `project`, `collect`, guarded `combine`, conflict branching, and integration `check`.
- The generator accepts bounded items with unique finite scalar `key` values. Full item JSON is retained as a bounded payload string in the item binding.
- Check authorization is not present in the template. Main preparation remains responsible for freezing the literal check.
- The Workbench catalog has a project-draft form for migration items, goal/instruction, and literal check argv/cwd/parser/timeout. It saves through the existing template store draft path.
- Unknown, stopped, or unsettled system effects remain blocked/unknown through existing map and system semantics. No source-workspace application path is created.

Verification covers generator shape, ordinary block validation, duplicate/unstable key rejection, authorization absence, and payload retention. The offline canonical Service/Runner/Interpreter matrix also proves:

- failed, unknown, and stopped candidates do not enter `combine`;
- an empty accepted set skips `combine` and integration check;
- conflicting accepted candidates retain durable conflict evidence and skip integration check;
- failed or unknown integration checks cannot become completed migration success;
- a fresh Service/Host over the canonical store retains completed evidence and resolves the combined replica;
- candidate and integration work leave the source workspace bytes unchanged.

Not claimed by this slice: real Provider/Jev/Claude quality, source application, commit/push/install/version, or a batch-specific filesystem-store cold reopen. The canonical SystemStep suite separately covers fresh filesystem-store reopen. The failed-item branch retains an excluded branch arm and candidate reference so the existing static type contract can prove the filtered candidate collection; only the `then` arm is projected into combine inputs.
