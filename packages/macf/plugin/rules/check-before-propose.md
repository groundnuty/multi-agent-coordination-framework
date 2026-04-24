# Check Before Propose

**Before proposing a technical shape, claiming a pattern is broken, or writing code against a memory of how the codebase looks — go read the current state.**

Three cognitive shortcuts repeatedly produce bad proposals:

1. "I remember how this works" → propose changes → the code moved, proposal is off
2. "This pattern is broken upstream" → the upstream pattern is fine; our implementation differs
3. "I'll write the fix" → write it against stale API shape → bash/run → surprised it fails

The fix is cheap: open the files, diff against a working peer, read the current convention. A one-minute check beats a twenty-minute unwind.

---

## 1. Check framework convention before proposing a shape

Before proposing a technical shape for cross-cutting design (flag naming, config structure, env-var layout, helm values pattern, GitHub Actions step shape, API surface), scan for how the project already does it:

- Grep the repo for similar patterns. If there are three existing instances, the fourth should match.
- Read the framework's own docs / DRs / reference implementations.
- Check adjacent configs (sibling charts, sibling workflows, sibling modules) for conventions you'd be breaking.

For GitHub Actions specifically: step-level `uses:` cannot evaluate `${{ }}` expressions at composition time — it's a static reference. Before proposing `uses: ${{ env.ACTION_REF }}`, check that you're in a job-level or input-level context where expression interpolation runs.

For helm charts: before proposing a new `values.yaml` key, check if the chart's `values.schema.json` or existing `README.md` defines a convention. Bitnami charts in particular have strict naming.

For language-specific configs: `tsconfig.json`, `pyproject.toml`, `go.mod`, `Cargo.toml` — conventions propagate across files in a project. New keys should match the tone of existing ones.

**The rule:** 1 minute of grep saves an embarrassing proposal that requires a subsequent "nvm, that's not how this project does it" turn.

---

## 2. Diff against a working consumer before blaming the pattern

When a call to some upstream pattern or library fails, the default hypothesis should be:

- **First:** my implementation differs from what works elsewhere
- **Second** (only after ruling out first): the pattern itself is broken

Find a known-working consumer and diff against your invocation:

    diff <(cat path/to/working-consumer) <(cat path/to/my-call)

Or for GitHub Actions: `gh run view` the working consumer's successful run, compare inputs. For helm: compare your `values.yaml` override against an upstream chart's `examples/`. For API calls: run the same call with the working caller's args and yours, compare the error bodies.

Claiming "pattern P is broken upstream" is a strong assertion. It should only survive:

- A found working consumer elsewhere with comparable inputs → if the working consumer exists, the pattern works; the diff IS the problem
- Or a dive into the upstream source confirming a recent regression with a commit SHA to cite

Without one of those, "pattern is broken" is almost always a misdiagnosis.

---

## 3. Before writing code against memory, read the file

If you "remember" that `src/foo.ts` exports a function `bar` that takes `(a, b)` — before writing code that calls it, read the file. APIs shift. Functions get renamed, arguments reshuffled, return types changed. A proposal that cites function signatures from memory is a proposal that gets written, attempted, failed, reverted.

This is the tightest version of the rule for coding work: **Read → Modify → Test**. Not Remember → Modify → Hope. The Read step is 5 seconds. The cost of skipping it is minutes of confused debugging when the memory-cached API doesn't match the current code.

For devops work specifically: before writing a helm values override, `helm show values <chart>` to see the current defaults. Before writing a `kubectl patch`, `kubectl get -o yaml` the current object shape. Before writing a `terraform import`, `terraform state show` similar resources to see the expected schema.

---

## 4. Before proposing config for a state surface, check where that state already lives

Don't build a parallel config surface when the state already has a home.

Example of the trap: an agent proposes adding an `agents.yaml` config file to track which bots are registered — but the bots are already tracked in GitHub App install sets + organization variables + the MACF registry. The proposed file would be a fourth, drift-prone source of truth.

Before designing a new config format / env var / secret pattern, ask:

- Does GitHub already know this? (App installations, org variables, repo secrets, team membership)
- Does the cluster already know this? (ConfigMap, Secret, labels on existing resources, helm release notes)
- Does the registry already know this? (MACF org variables, service catalog, feature flags)
- Does the filesystem already know this? (existing `.env`, `.gitconfig`, `values.yaml` file)

If yes, your new config should either read from the existing source or be built alongside it, not parallel to it.

---

## Why this rule exists

The failure mode this rule catches isn't sloppiness — it's the opposite. It's the confident proposal from a well-informed agent whose mental model is slightly stale. The fix isn't to be less confident; it's to cheaply refresh the mental model before spending the confidence.

One `grep`, one `gh pr view`, one `helm show values` — then propose. The check adds seconds. The recovery from a misaimed proposal adds minutes of peer time and muddies the thread.
