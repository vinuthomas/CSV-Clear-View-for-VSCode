# Regenerates samples/orders_sample.parquet, a small file for README screenshots:
#   pip install pyarrow; python3 samples/make_screenshot_parquet.py samples/orders_sample.parquet
import sys, random, datetime as dt, pyarrow as pa, pyarrow.parquet as pq
random.seed(7)
n = 40
cities = ['London', 'Paris', 'Berlin', 'Madrid', 'Lisbon', 'Vienna', 'Oslo', 'Rome']
names = ['Maya Okafor', 'Liam Novak', 'Sofia Brandt', 'Arjun Mehta', 'Elena Rossi',
         'Noah Fischer', 'Aiko Tanaka', 'Lucas Moreau', 'Zara Haddad', 'Oskar Lindqvist']
prices = {'Laptop': 1299.0, 'Monitor': 249.0, 'Keyboard': 89.9, 'Mouse': 24.5,
          'Headphones': 129.0, 'Webcam': 49.0, 'Dock': 189.0, 'Cable': 19.99}
products = list(prices)
status = ['shipped', 'delivered', 'pending', 'cancelled']
base = dt.datetime(2026, 9, 1, 9, 0)
rows = []
for i in range(n):
    product = random.choice(products)
    qty = random.randint(1, 4)
    rows.append({
        'order_id': 100000 + i * 7,
        'customer': random.choice(names),
        'city': random.choice(cities),
        'product': product,
        'quantity': qty,
        'unit_price': prices[product],
        'status': random.choices(status, [5, 8, 3, 1])[0],
        'ordered_at': base + dt.timedelta(hours=random.randint(0, 24 * 60)),
        'tags': random.sample(['gift', 'express', 'b2b', 'returning'], random.randint(0, 2)),
        'shipping': {'carrier': random.choice(['DHL', 'UPS', 'FedEx']), 'days': random.randint(1, 5)},
    })
t = pa.Table.from_pylist(rows, schema=pa.schema([
    ('order_id', pa.int64()), ('customer', pa.string()), ('city', pa.string()), ('product', pa.string()),
    ('quantity', pa.int32()), ('unit_price', pa.float64()), ('status', pa.string()),
    ('ordered_at', pa.timestamp('ms', tz='UTC')), ('tags', pa.list_(pa.string())),
    ('shipping', pa.struct([('carrier', pa.string()), ('days', pa.int32())])),
]))
pq.write_table(t, sys.argv[1], compression='snappy')
print(t.num_rows, 'rows')
