# Contributing to Storage Bench

Thanks for helping. Storage Bench is part of OpenShift Community Tools (OCT), a
community project that is not officially supported by Red Hat. Bug fixes, new
options and docs improvements are all welcome. For larger changes, open an
issue first so we can agree on the approach before you spend time on it.

## Setup

Requirements: Node.js 20 and Corepack (it provides the Yarn version pinned in
`package.json`) and Go (version in `benchmark-runner/go.mod`) for the companion service.

```bash
corepack enable
yarn install
yarn verify    # type check, translation keys, repository rules, production build
```

For `benchmark-runner/`:

```bash
cd benchmark-runner && go vet ./... && go test ./...
```

The same checks run in GitHub Actions on every pull request. A pull request
can be merged when they pass and a maintainer has reviewed it.

## Test on your own cluster

Use a lab cluster you can afford to break.

Build your image and push it to a registry you own (make the repository public,
or add a pull secret):

```bash
podman build -t quay.io/<you>/oct-storage-bench:dev -f Containerfile .
podman push quay.io/<you>/oct-storage-bench:dev
```

**If Storage Bench is already installed from the storefront**, swap in your image:

```bash
oc set image deploy/oct-storage-bench -n oct-storage-bench plugin=quay.io/<you>/oct-storage-bench:dev
```

**Otherwise** deploy the YAML in this repo with your image:

```bash
for f in namespace rbac service deployment consoleplugin; do
  sed 's|quay.io/cjanisze/oct-storage-bench:[^ ]*|quay.io/<you>/oct-storage-bench:dev|' deploy/$f.yaml | oc apply -f -
done
```

and enable the plugin in the console (skip if the storefront already enabled it):

```bash
oc patch console.operator cluster --type=json \
  -p '[{"op":"add","path":"/spec/plugins/-","value":"oct-storage-bench"}]'
```

The page is at **Community Tools → Storage → Storage Bench** (`/community-tools/storage/bench`). After pushing a new `:dev`
image, restart the plugin pod (`oc rollout restart deploy/oct-storage-bench -n oct-storage-bench`)
and reload the console.

**Benchmark runner (`oct-storage-bench-runner`)** (`benchmark-runner/`): build it with
`podman build -t quay.io/<you>/oct-storage-bench-runner:dev -f benchmark-runner/Containerfile benchmark-runner/` and push it. It runs as Deployment `benchmark-runner`: `oc set image deploy/benchmark-runner -n oct-storage-bench benchmark-runner=quay.io/<you>/oct-storage-bench-runner:dev`.

Not able to test on a cluster? Say so in the pull request and describe what you
checked instead (for example the page's YAML preview, or output of the functions
you changed). A maintainer tests it before the release.

## Rules

- **PatternFly 6** components only. Do not import PatternFly CSS; the console provides it.
- **Translations:** every UI string goes through `t('...')` and has an entry in
  `locales/en/plugin__oct-storage-bench.json`. `yarn check-i18n --fix` adds missing ones.
- **No environment-specific values:** no hostnames, IPs, VLAN IDs, NIC names,
  StorageClasses, cluster URLs or tokens in code or docs. Read live cluster state
  and let the user choose.
- Benchmarks write real load to the storage: run them on test clusters, and keep Cancel working.
- Keep the sidecar proxy alias `benchmark-runner`, the results ConfigMap `sb-bench-results` and the `=== FIO_RESULT <workload> ===` output marker unchanged; saved results and the UI depend on them.
- **Wording:** this is a community project; do not describe it as official Red Hat software.
- [AGENTS.md](AGENTS.md) describes the design in detail. It is also the guide
  for AI coding assistants, which are welcome; please review what they produce.

## Releases (maintainers)

Leave these to the maintainers. Do not change them in a pull request:

- the version in `package.json` (both places), README, AGENTS.md and the deploy YAML
- container images (`<version>-ocp4.22` and `-ocp4.21`, including the companion image; published tags are never overwritten)
- git tags and the storefront catalog rows

## License

By contributing you agree that your contribution is licensed under the
[Apache License 2.0](https://www.apache.org/licenses/LICENSE-2.0), the license of this project.
