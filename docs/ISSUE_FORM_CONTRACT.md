# Issue form consumer

Golf reads templates from one exact default-branch commit through the supported forge contents API. Markdown templates remain editable prefilled drafts. YAML forms in `.github/ISSUE_TEMPLATE` and `.gitea/ISSUE_TEMPLATE` now have a bounded real renderer for `markdown`, `input`, `textarea`, `dropdown` and `checkboxes`.

The parser refuses unknown schema keys/field types, duplicate IDs/options, YAML aliases/anchors/multiple documents, invalid option indices/render languages and malformed/oversized content. A file is capped at6000UTF-8bytes,30fields,50options per choice field, and the existing50-template inventory bound remains. Supported constraints include required fields, required checkbox options, minimum text length, dropdown defaults/multiple selection and textarea code rendering. Unsupported upload fields and future constraints are counted as unsupported; they are not silently dropped.

The shared chooser opens a TanStack form only when requested. Required fields are checked before preparing an editable Markdown draft through the existing issue composer and durable create journal. Informational Markdown stays in the form and is omitted from the submitted body; textarea code fences grow past embedded backtick runs. The combined draft must fit the existing6000-byte issue limit. The final title/body can be reviewed and edited before posting, so form validation is a drafting aid rather than a server-enforced repository policy. Template labels, assignees and project declarations do not cause implicit mutations; users configure supported metadata separately.

Source evidence consists of the strict Go parser checks and issue browser tests verifying required choices, defaults, Markdown serialization and the existing draft flow. Native exact-commit template reads and actual creation need their separate provider/runtime receipt; a source form fixture does not establish those.

Attachments, template configuration/contact links, unsupported schema extensions, query-parameter prefills and complete cross-provider form parity remain acceptance work.

Primary schema references: [GitHub form schema](https://docs.github.com/en/communities/using-templates-to-encourage-useful-issues-and-pull-requests/syntax-for-githubs-form-schema), [Gitea issue templates](https://docs.gitea.com/usage/issues-prs/issue-pull-request-templates/).
