# Regenerates samples/orders_1m.parquet (1M rows, ~27MB on disk, ~45MB uncompressed, 10 row groups):
#   pip install pyarrow; python3 samples/make_parquet_sample.py samples/orders_1m.parquet
import sys, datetime as dt, random, pyarrow as pa, pyarrow.parquet as pq
random.seed(1)
n = 1_000_000
cities = ['London', 'Paris', 'Berlin', 'Madrid', 'Rome', 'Oslo', 'Lisbon', 'Vienna']
base = dt.datetime(2026, 1, 1)
t = pa.table({
    'order_id': pa.array(range(1, n + 1), pa.int64()),
    'customer': pa.array([f'customer_{random.randint(1, 50000):05d}' for _ in range(n)]),
    'city': pa.array([random.choice(cities) for _ in range(n)]),
    'amount': pa.array([round(random.uniform(1, 500), 2) for _ in range(n)], pa.float64()),
    'paid': pa.array([random.random() > 0.1 for _ in range(n)]),
    'ordered_at': pa.array([base + dt.timedelta(seconds=random.randint(0, 30_000_000)) for _ in range(n)], pa.timestamp('ms', tz='UTC')),
    'notes': pa.array([None if random.random() > 0.2 else f'note for order {i}, handle with care' for i in range(n)]),
    'items': pa.array([[random.randint(1, 999) for _ in range(random.randint(0, 3))] for _ in range(n)], pa.list_(pa.int32())),
})
pq.write_table(t, sys.argv[1], compression='snappy', row_group_size=100_000)
m = pq.ParquetFile(sys.argv[1]).metadata
print(m.num_rows, 'rows,', m.num_row_groups, 'row groups,', round(sum(m.row_group(i).total_byte_size for i in range(m.num_row_groups)) / 2**20, 1), 'MB uncompressed')
