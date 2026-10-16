package server

// Names that Forgejo itself defines. Forgejo is a fork and still uses a few of
// its predecessor's identifiers on the wire; Golf must match them exactly.

// forgejoReportedVersion is what the pinned Forgejo 15.0.9 image returns from
// /api/v1/version. The "+gitea-1.22.0" build suffix is Forgejo's upstream name.
const forgejoReportedVersion = "15.0.9+gitea-1.22.0"
