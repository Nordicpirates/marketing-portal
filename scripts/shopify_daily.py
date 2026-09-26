#!/usr/bin/env python3
"""Shopify orders per Stockholm day (EUR, cancelled skipped). Run through gate vault exec, see docs/DAILY-REFRESH.md."""
import json,os,sys,urllib.request,urllib.parse,time
from datetime import datetime,timezone
from zoneinfo import ZoneInfo
SHOP='2b988c-3.myshopify.com'
cid=os.environ['CID']; cs=os.environ['CS']
since=sys.argv[1] if len(sys.argv)>1 else '2026-08-25'
out=sys.argv[2] if len(sys.argv)>2 else '/home/gate-lyingpirates-bengt/tmp/shopify_daily.json'
body=urllib.parse.urlencode({'client_id':cid,'client_secret':cs,'grant_type':'client_credentials'}).encode()
req=urllib.request.Request(f'https://{SHOP}/admin/oauth/access_token',data=body,headers={'Content-Type':'application/x-www-form-urlencoded'})
tok=json.loads(urllib.request.urlopen(req,timeout=60).read())['access_token']
URL=f'https://{SHOP}/admin/api/2025-01/graphql.json'
Q='''query($q:String!,$after:String){orders(first:250,query:$q,sortKey:CREATED_AT,after:$after){
pageInfo{hasNextPage endCursor}
nodes{name createdAt cancelledAt currentTotalPriceSet{shopMoney{amount currencyCode}}}}}'''
after=None; rows=[]
while True:
    b=json.dumps({'query':Q,'variables':{'q':f'created_at:>={since}','after':after}}).encode()
    r=urllib.request.Request(URL,data=b,headers={'X-Shopify-Access-Token':tok,'Content-Type':'application/json'})
    d=json.loads(urllib.request.urlopen(r,timeout=120).read())
    if 'errors' in d: print('GQL ERR',json.dumps(d['errors'])[:500]); sys.exit(1)
    o=d['data']['orders']; rows+=o['nodes']
    if not o['pageInfo']['hasNextPage']: break
    after=o['pageInfo']['endCursor']; time.sleep(.4)
tz=ZoneInfo('Europe/Stockholm'); days={}
cur=set()
for n in rows:
    if n.get('cancelledAt'): continue
    dt=datetime.fromisoformat(n['createdAt'].replace('Z','+00:00')).astimezone(tz)
    k=dt.strftime('%Y-%m-%d'); m=n['currentTotalPriceSet']['shopMoney']; cur.add(m['currencyCode'])
    e=days.setdefault(k,{'date':k,'orders':0,'revenue_eur':0.0})
    e['orders']+=1; e['revenue_eur']+=float(m['amount'])
for e in days.values(): e['revenue_eur']=round(e['revenue_eur'],2)
res={'since':since,'fetched_at':datetime.now(timezone.utc).isoformat(timespec='seconds'),'currency':sorted(cur),'total_orders':len(rows),'days':[days[k] for k in sorted(days)]}
json.dump(res,open(out,'w'),indent=1)
print('orders fetched',len(rows),'currencies',sorted(cur))
for e in res['days'][-8:]: print(e)
