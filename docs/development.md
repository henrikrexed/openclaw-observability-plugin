# Development

How to develop, test, and contribute to the plugin.

## Setup

```bash
# Clone
git clone https://github.com/henrikrexed/openclaw-observability-plugin.git
cd openclaw-observability-plugin

# Install dependencies
npm install

# Link to OpenClaw (live development)
openclaw plugins install -l .

# Restart gateway to pick up the plugin
openclaw gateway restart
```

## Project Structure

```
openclaw-observability-plugin/
├── index.ts                    # Plugin entry point
├── src/
│   ├── config.ts               # Configuration parsing
│   ├── telemetry.ts            # OTel SDK setup (providers, exporters, instruments)
│   ├── openllmetry.ts          # GenAI instrumentation status check
│   └── hooks.ts                # OpenClaw event hooks
├── collector/
│   └── otel-collector-config.yaml  # OTel Collector config
├── docs/                       # MkDocs documentation
├── openclaw.plugin.json        # Plugin manifest
├── package.json
├── tsconfig.json
├── mkdocs.yml
└── docker-compose.yaml
```

## Development Workflow

### 1. Make Changes

Edit the TypeScript files in `src/` or `index.ts`.

### 2. Restart Gateway

OpenClaw uses [jiti](https://github.com/unjs/jiti) to load TypeScript at runtime, so no build step is needed:

```bash
openclaw gateway restart
```

### 3. Verify

```bash
# Check plugin loaded
openclaw otel

# Check gateway logs for [otel] messages
tail -f ~/.openclaw/gateway.log | grep otel
```

### 4. Test with Debug Exporter

For quick development, use the collector's debug exporter to see spans in stdout:

```bash
docker compose up -d
docker compose logs -f otel-collector
```

Every exported span/metric will appear in the collector logs.

## Type Checking

```bash
npm run typecheck
```

!!! note
    The plugin uses OpenClaw's plugin API via `any` types since the SDK types aren't published separately yet. Once `openclaw/plugin-sdk` is published, we'll add proper type imports.

## Testing Locally Without a Backend

You can run with just the debug exporter (no Dynatrace/Grafana needed):

1. Edit `collector/otel-collector-config.yaml`:

    ```yaml
    service:
      pipelines:
        traces:
          receivers: [otlp]
          processors: [batch]
          exporters: [debug]  # Remove dynatrace exporter
    ```

2. Start the collector: `docker compose up -d`
3. Watch spans: `docker compose logs -f otel-collector`
4. Send messages to your OpenClaw agent — you'll see spans appear in the logs

## Adding New Metrics

1. Define the instrument in `src/telemetry.ts`:

    ```typescript
    // In OtelCounters interface
    myNewMetric: Counter;

    // In initTelemetry()
    myNewMetric: meter.createCounter("openclaw.my.new_metric", {
      description: "Description of what this measures",
      unit: "unit",
    }),
    ```

2. Record values in `src/hooks.ts` or `index.ts`:

    ```typescript
    telemetry.counters.myNewMetric.add(1, { "attribute.key": "value" });
    ```

3. Document in `docs/telemetry/metrics.md`

## Adding New Spans

1. Use the tracer in `src/hooks.ts`:

    ```typescript
    const span = tracer.startSpan("openclaw.my.operation", {
      kind: SpanKind.INTERNAL,
      attributes: {
        "openclaw.my.attribute": "value",
      },
    });

    // ... do work ...

    span.setStatus({ code: SpanStatusCode.OK });
    span.end();
    ```

2. Document in `docs/telemetry/traces.md`

## Building the Documentation

```bash
# Install MkDocs (one-time)
pip install mkdocs-material

# Serve locally
mkdocs serve

# Build static site
mkdocs build

# Deploy to GitHub Pages
mkdocs gh-deploy
```

## Publishing to npm

When ready to publish as an installable OpenClaw plugin:

```bash
# Update version in package.json and openclaw.plugin.json
npm version patch

# Publish
npm publish --access public
```

Users can then install with:

```bash
openclaw plugins install @openclaw/otel-observability
```

## Contributing

1. Fork the repository
2. Create a feature branch: `git checkout -b feature/my-feature`
3. Make your changes
4. Run type-check: `npm run typecheck`
5. Test with a local collector
6. Submit a pull request

### Commit Convention

Use conventional commits:

- `feat: add new metric for session duration`
- `fix: handle missing tool name in hook`
- `docs: update Dynatrace setup guide`
- `refactor: simplify config parsing`
