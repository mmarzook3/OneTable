param([ValidateSet('local','vps')][string]$Target='local')
$ErrorActionPreference='Stop'
$setup=@'
import json,uuid,hashlib
from datetime import timedelta,datetime,timezone
from sqlmodel import Session,select
from app import models as m,security
from app.db import engine
def protected(s):
 data=[x.model_dump(mode='json') for x in s.exec(select(m.Order).where(m.Order.id.in_([147,149,157]))).all()]+[x.model_dump(mode='json') for x in s.exec(select(m.OrderPayment).where(m.OrderPayment.order_id.in_([147,149,157]))).all()]
 return hashlib.sha256(json.dumps(data,sort_keys=True).encode()).hexdigest()
with Session(engine) as s:
 baseline=protected(s);marker='Phase3 Overpayment '+uuid.uuid4().hex
 t=m.Tenant(name=marker,timezone='Europe/London',currency_code='GBP',currency='GBP',tse_mode='off',tip_entry_mode='overpayment',reservation_reminder_24h_enabled=False,reservation_reminder_2h_enabled=False);s.add(t);s.flush()
 floor=m.Floor(tenant_id=t.id,name='Synthetic Room',sort_order=0);s.add(floor);s.flush()
 table=m.Table(tenant_id=t.id,floor_id=floor.id,name='Synthetic Table',token=uuid.uuid4().hex,x_position=0,y_position=0,rotation=0,shape='rect',width=1,height=1,seat_count=4,is_active=True);s.add(table)
 owner=m.User(tenant_id=t.id,email='phase3-overpayment-'+uuid.uuid4().hex+'@amvara.de',hashed_password=security.get_password_hash(uuid.uuid4().hex),full_name='Synthetic Owner',role=m.UserRole.owner,must_change_password=False);s.add(owner)
 product=m.Product(tenant_id=t.id,name='Synthetic Overpayment Item',price_cents=500,category='Main Course');s.add(product);s.flush()
 cases=[]
 for name,basket,fee,tip,prior,voided in [('net-exact',500,0,0,0,0),('auto-tip',500,0,0,0,0),('delivery-prior',500,100,50,100,0),('capped-discount',100,0,50,0,0),('underpayment',500,0,0,0,0),('voided-prior',500,0,0,100,200)]:
  o=m.Order(tenant_id=t.id,table_id=None if fee else table.id,status=m.OrderStatus.pending,notes=marker,requires_prepayment=False,loyalty_discount_cents=200,tip_amount_cents=tip,delivery_fee_cents=fee)
  if fee:o.order_channel=m.OrderChannel.satisfecho_delivery;o.delivery_address='Synthetic address'
  s.add(o);s.flush()
  if o.id in (147,149,157):raise ValueError('Protected ID collision')
  s.add(m.OrderItem(order_id=o.id,product_id=product.id,product_name=product.name,quantity=1,price_cents=basket,status=m.OrderItemStatus.pending))
  if prior:s.add(m.OrderPayment(tenant_id=t.id,order_id=o.id,amount_cents=prior,payment_method='cash',note='Synthetic prior'))
  if voided:s.add(m.OrderPayment(tenant_id=t.id,order_id=o.id,amount_cents=voided,payment_method='cash',note='Synthetic void',voided_at=datetime.now(timezone.utc)))
  cases.append(dict(name=name,orderId=o.id))
 token=security.create_access_token(dict(sub=owner.email,tenant_id=t.id,provider_id=None,token_version=owner.token_version),expires_delta=timedelta(minutes=20))
 s.commit()
 print(json.dumps(dict(synthetic=True,tenantId=t.id,marker=marker,token=token,protected=baseline,cases=cases)))
'@
$cleanup=@'
import json,base64,hashlib,warnings,re
from sqlmodel import Session,SQLModel,select
from sqlalchemy import delete
from app import models as m
from app.db import engine
state=json.loads(base64.b64decode('STATE_BASE64'))
def require(ok):
 if not ok:raise ValueError('Synthetic cleanup guard failed')
def protected(s):
 data=[x.model_dump(mode='json') for x in s.exec(select(m.Order).where(m.Order.id.in_([147,149,157]))).all()]+[x.model_dump(mode='json') for x in s.exec(select(m.OrderPayment).where(m.OrderPayment.order_id.in_([147,149,157]))).all()]
 return hashlib.sha256(json.dumps(data,sort_keys=True).encode()).hexdigest()
with Session(engine) as s:
 tid=state['tenantId'];t=s.get(m.Tenant,tid)
 require(tid not in [1,23,25] and t is not None and t.name==state['marker'] and re.fullmatch(r'Phase3 Overpayment [a-f0-9]{32}',t.name))
 orders=s.exec(select(m.Order).where(m.Order.tenant_id==tid)).all();ids=[o.id for o in orders]
 require(set(ids)=={c['orderId'] for c in state['cases']} and not set(ids)&{147,149,157})
 require(all(o.notes==state['marker'] and not o.stripe_payment_intent_id and not o.revolut_order_id for o in orders))
 pp=s.exec(select(m.OrderPayment).where(m.OrderPayment.tenant_id==tid)).all()
 require(all(p.payment_method=='cash' and not p.stripe_payment_intent_id for p in pp))
 pids=[p.id for p in pp]
 if pids:s.execute(delete(m.OrderPaymentItem).where(m.OrderPaymentItem.order_payment_id.in_(pids)))
 s.execute(delete(m.OrderItem).where(m.OrderItem.order_id.in_(ids)))
 with warnings.catch_warnings():
  warnings.simplefilter('ignore');tables=list(SQLModel.metadata.sorted_tables)
 for table in reversed(tables):
  if 'tenant_id' in table.c:s.execute(delete(table).where(table.c.tenant_id==tid))
 s.execute(delete(m.Tenant).where(m.Tenant.id==tid));s.flush();s.expire_all()
 require(s.get(m.Tenant,tid) is None and protected(s)==state['protected']);s.commit()
 print(json.dumps(dict(cleanup='PASS',tenant_removed=tid,orders_removed=len(ids),protected_orders_unchanged=True)))
'@
function Invoke-Backend([string]$Code) {
 if($Target -eq 'local') { $out=$Code | docker exec -i pos-back python - } else { $out=$Code | ssh -o BatchMode=yes gatlieros-vps "tr -d '\r' | docker exec -i scanaki-back python -" }
 if($LASTEXITCODE -ne 0){throw 'Synthetic backend command failed'}
 return $out
}
$raw=Invoke-Backend $setup
$state=$raw | ConvertFrom-Json
$state | Add-Member target $Target
$state | Add-Member baseUrl $(if($Target -eq 'local'){'http://haproxy:4202/'}else{'https://scanaki.uk/'})
try {
 $private=$state | ConvertTo-Json -Depth 8 -Compress
 $flags=@('--execute','--allow-synthetic');if($Target -eq 'vps'){$flags+='--allow-remote-synthetic'}
 $result=$private | docker exec -i pos-front node scripts/test-overpayment-net-due.mjs @flags
 $testExit=$LASTEXITCODE
 $result | Set-Content "tmp/phase3-overpayment-$Target-browser.json" -Encoding utf8
 Write-Output $result
} finally {
 $state.PSObject.Properties.Remove('token')
 $encoded=[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes(($state | ConvertTo-Json -Depth 8 -Compress)))
 $result=Invoke-Backend ($cleanup.Replace('STATE_BASE64',$encoded))
 $result | Set-Content "tmp/phase3-overpayment-$Target-cleanup.json" -Encoding utf8
 Write-Output $result
 Remove-Variable raw,private -ErrorAction SilentlyContinue
}
if($testExit -ne 0){throw 'Targeted browser regression failed; fixture cleaned'}
