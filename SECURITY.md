# Security Policy

## Supported Versions

Security updates are provided for the latest published release of
`@henrikrexed/openclaw-otel-observability`.

| Version | Supported |
| ------- | --------- |
| latest  | ✅        |
| older   | ❌        |

## Reporting a Vulnerability

If you discover a security vulnerability in this plugin, please report it
privately rather than opening a public issue.

- **Preferred:** open a [GitHub security advisory](https://github.com/henrikrexed/openclaw-observability-plugin/security/advisories/new)
  for this repository.
- **Alternative:** email the maintainer at `henrik@perfbytes.com` with the
  details and a way to reproduce.

Please include:

- a description of the vulnerability and its impact,
- steps to reproduce or a proof of concept, and
- any suggested remediation if you have one.

## Response Expectations

- We aim to acknowledge reports within 5 business days.
- Once validated, we will work on a fix and coordinate a disclosure timeline
  with the reporter.
- Credit will be given to reporters who wish to be acknowledged.

## Scope

This policy covers the plugin source in this repository. The plugin emits
OpenTelemetry traces, metrics, and logs; it redacts known credential patterns
before export, but operators are responsible for securing their own OTLP
endpoints and API tokens.
