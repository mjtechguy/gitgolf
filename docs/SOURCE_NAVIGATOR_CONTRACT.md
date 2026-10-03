# Source navigation workspace

Golf's non-root source view uses a compact contextual Files panel next to the shared source preview. Directory disclosure buttons expand without changing the viewed file. Independent file/directory links open canonical `blob/FULL_COMMIT/PATH` or `tree/FULL_COMMIT/PATH` routes. Symlinks and submodules open their existing metadata-only source views; navigation does not follow them or fetch another repository.

## Reads and boundaries

The navigator uses the generated `GetContents` procedure and supported native forge APIs. Every requested folder is pinned to the displayed full40/64-character commit. Responses must identify that exact commit, literal directory path and directory kind, contain no more than1000 entries, and contain unique valid direct-child paths with supported entry types. A mismatch is an error, never another source tree silently displayed under the requested identity.

Initial selected-file ancestors load in parallel. The selected directory itself opens once its parent metadata is available. Traversal has at most64 simultaneously expanded directories including the root, at most32 directory levels, and at most1000 returned entries per directory. Reaching the expansion bound shows a notice and retains the ordinary pinned directory link. Visual nesting stops adding indentation after eight levels while full literal paths remain available in link titles. There is no recursive whole-repository fetch, pagination invented for the native directory API, or automatic traversal of closed siblings.

The filter is explicitly labeled **Filter expanded folder entries** and searches only currently loaded entries in expanded folders. It displays full paths in matching results. It does not discover unloaded files, issue a native repository-wide search, or imply complete results. Closing a folder removes its descendant queries and filter candidates. Closing the entire Files panel unmounts its directory reads. On narrow screens the panel starts collapsed; keyboard Enter/Space, native links, named disclosure buttons and44px mobile controls remain available.

## Private state and authority

Query keys include the current account ID, owner/name, native repository ID, exact commit and literal directory path, using the existing repository query prefix. Keys reset all in-memory navigation state on account, repository identity or commit changes. Private query data has zero inactive retention; paths, filters and expansion are never written to local/session storage. Any expanded-folder failure removes all tree entries and filter results until a real successful retry. Existing live repository revocation cancels/removes these scoped queries and the parent metadata denial unmounts the panel.

The current `GetContents` contract has **no expected native repository ID or native identity receipt**. The repository ID in frontend query keys isolates UI state; it does not create a server identity fence. The navigator inherits the existing source API's authorization and native reads. It must not be described as strengthening backend source authorization, guaranteeing atomic repository access, or proving a native repository identity across rename/recreation. Broader source authorization/identity qualification remains separate work.

The panel mounts after the main source read succeeds. Main source revalidation/navigation can unmount it, so folders and filters may reset to the selected path's ancestors; this is safe disposable navigation state, not persisted expansion. Collapse state is also in memory. No file writes, editor, blame, rename-following history, full-repository search or background native fetch of closed siblings are introduced.

## Evidence

`web/tests/source-navigator.spec.ts` uses the same generated protocol descriptors as the browser. It covers pinned lazy reads and literal special names, canonical navigation, loaded-only filtering and collapse, selected-file reload, selected-directory expansion,32-level bounds with ordinary deeper navigation, wrong snapshot/malformed metadata/source denial and successful retry, native identity reset, private storage absence and both themes at390px.

These are browser fixtures, not native provider qualification. Actual deployed screenshots and native source/revocation proof must be recorded in the implementation ledger before marking this increment verified in a live installation. The broader GitHub-parity goal remains open.
