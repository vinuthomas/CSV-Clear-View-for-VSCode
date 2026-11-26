# Regenerates the Parquet test fixtures: pip install pyarrow; python3 tests/fixtures/make_parquet_fixtures.py tests/fixtures
import sys, datetime as dt, pyarrow as pa, pyarrow.parquet as pq
out = sys.argv[1]
t = pa.table({
    'id': pa.array([1, 2, 3], pa.int32()),
    'big': pa.array([9007199254740993, -1, None], pa.int64()),
    'price': pa.array([1.5, None, -0.25], pa.float64()),
    'flag': pa.array([True, False, None], pa.bool_()),
    'name': pa.array(['plain', 'has, comma', 'say "hi"\nbye'], pa.string()),
    'note': pa.array([None, '', 'x'], pa.string()),
    'day': pa.array([dt.date(2024, 1, 31), None, dt.date(1970, 1, 1)], pa.date32()),
    'ts': pa.array([dt.datetime(2024, 1, 31, 12, 30, 45, 123000), None, dt.datetime(2000, 1, 1)], pa.timestamp('ms', tz='UTC')),
    'blob': pa.array([b'\x00\xff\x10', None, b'ok'], pa.binary()),
    'tags': pa.array([[1, 2], [], None], pa.list_(pa.int64())),
    'pt': pa.array([{'a': 1, 'b': 'x'}, None, {'a': 2, 'b': None}], pa.struct([('a', pa.int64()), ('b', pa.string())])),
    'attrs': pa.array([[('k', 1)], None, []], pa.map_(pa.string(), pa.int32())),
})
pq.write_table(t, f'{out}/types.snappy.parquet', compression='snappy')
pq.write_table(t, f'{out}/types.zstd.parquet', compression='zstd')
n = pa.table({'n': pa.array(range(100), pa.int64())})
pq.write_table(n, f'{out}/rowgroups.parquet', compression='snappy', row_group_size=25)
c = pa.table({'s': pa.array(['a', 'b'], pa.string())})
for codec in ['gzip', 'brotli', 'lz4']:
    pq.write_table(c, f'{out}/codec.{codec}.parquet', compression=codec)
# Compresses ~60x: tiny on disk, over 1MB uncompressed (for the size-gate test)
e = pa.table({'s': pa.array(['the same fifty-character string, repeated again...'] * 20000, pa.string())})
pq.write_table(e, f'{out}/expands.parquet', compression='zstd', use_dictionary=False)
