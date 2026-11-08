# cart

Shopping cart pricing. Zero dependencies, `node:test` runner.

```bash
npm test
```

## API

| Function | Description |
| --- | --- |
| `subtotal(items)` | sum of `price * qty` |
| `total(items, discountRate)` | subtotal after discount, rounded to 2 decimals |
| `unitCount(items)` | total physical units |

## Fixture note

Benchmark fixture for bro2 (`data/fixtures/repos/`). No install step, visible tests green.
See `data/fixtures/repos/manifest.json` for the pinned content hash.
