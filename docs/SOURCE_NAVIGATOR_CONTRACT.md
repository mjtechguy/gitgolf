# Source navigation workspace

Golf's non-root source view uses a compact contextual Files panel next to the shared source preview. Directory disclosure buttons expand without changing the viewed file. Independent file/directory links open canonical `blob/FULL_COMMIT/PATH` or `tree/FULL_COMMIT/PATH` routes. Symlinks and submodules open their existing metadata-only source views; navigation does not follow them or fetch another repository.

## Reads and boundaries

The navigator uses the generated `GetContents` procedure and supported native forge APIs. Every requested folder is pinned to the displayed full40/64-character commit. Responses must identify that exact commit, literal directory path and directory kind, contain no more than1000 entries, and contain unique valid direct-child paths with supported entry types. A mismatch is an error, never another source tree silently displayed under the requested identity.

Initial selected-file ancestors load in parallel. The selected directory itself opens once its parent metadata is available. Traversal has at most64 simultaneously expanded directories including the root, at most32 directory levels, and at most1000 returned entries per directory. Reaching the expansion bound shows a notice and retains the ordinary pinned directory link. Visual nesting stops adding indentation after eight levels while full literal paths remain available in link titles. There is no recursive whole-repository fetch, pagination invented for the native directory API, or automatic traversal of closed siblings.

The filter is explicitly labeled **Filter expanded folder entries** and searches only currently loaded entries in expanded folders. It displays full paths in matching results. It does not discover unloaded files, issue a native repository-wide search, or imply complete results. Closing a folder removes its descendant queries and filter candidates. Closing the entire Files panel unmounts its directory reads. On narrow screens the panel starts collapsed; keyboard Enter/Space, native links, named disclosure buttons and44px mobile controls remain available.

## Private state and authority

Query keys include the current account ID, owner/name, native repository ID, exact commit and literal directory path, using the existing repository query prefix. Keys reset all in-memory navigation state on account, repository identity or commit changes. Private query data has zero inactive retention; paths, filters and expansion are never written to local/session storage. Any expanded-folder failure removes all tree entries and filter results until a real successful retry. Existing live repository revocation cancels/removes these scoped queries and the parent metadata denial unmounts the panel.

RS-1 now requires the expected native repository ID and full commit for every navigator read, and validates returned ID/commit/path/kind before rendering. The server independently observes current native caller/repository authority before and after bounded exact object reads; browser query keys are still only UI isolation. Exact Git trees/blobs replace SHA-shadowable `contents-ext` reads. These observations do not establish an atomic permission/ref lock, safe rename following or protection against address replacement between all observations. See [source identity design and qualification](READABLE_SOURCE_URL_DESIGN.md).

The panel mounts after the main source read succeeds. Main source revalidation/navigation can unmount it, so folders and filters may reset to the selected path's ancestors; this is safe disposable navigation state, not persisted expansion. Collapse state is also in memory. No file writes, editor, blame, rename-following history, full-repository search or background native fetch of closed siblings are introduced.

## Evidence

`web/tests/source-navigator.spec.ts` uses the same generated protocol descriptors as the browser. It covers pinned lazy reads and literal special names, canonical navigation, loaded-only filtering and collapse, selected-file reload, selected-directory expansion,32-level bounds with ordinary deeper navigation, wrong snapshot/malformed metadata/source denial and successful retry, native identity reset, private storage absence and both themes at390px.

The original cases are browser fixtures. RS-1 additionally has supported-native exact tree/blob/image and actual served source/revocation proof, recorded with its runtime identity in the [implementation ledger](IMPLEMENTATION_STATUS.md). These bounded checks do not qualify every navigator expansion against a real provider or complete readable URLs. The broader GitHub-parity goal remains open.
