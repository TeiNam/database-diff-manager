shop 
=============

## Table List
- [big_paid (VIEW)](#big_paid)
 - [order_audit ()](#order_audit)
 - [orders ()](#orders)
 - [paid_orders (VIEW)](#paid_orders)
 
## big_paid
**Information**
|Table type|Charset|Collate|
|---|---|---|
|VIEW|latin1|latin1_swedish_ci|

**View Create SQL**

```sql
CREATE ALGORITHM=UNDEFINED DEFINER=`root`@`localhost` SQL SECURITY DEFINER VIEW `big_paid` AS select `paid_orders`.`id` AS `id` from `paid_orders` where (`paid_orders`.`amount` > 100)
```
 
## order_audit
**Information**
|Table type|Engine|Row format|Collate|Comment|
|---|---|---|---|---|
|BASE TABLE|InnoDB|Dynamic|utf8mb4_0900_ai_ci||

**Columns**
|Name|Type|Nullable|Default|Charset|Collation|Key|Extra|Comment|
|---|---|---|---|---|---|---|---|---|
|id|int|NO||||PRI|auto_increment||
|order_id|int|NO|||||||
|at|datetime|NO|CURRENT_TIMESTAMP||||DEFAULT_GENERATED||

 
## orders
**Information**
|Table type|Engine|Row format|Collate|Comment|
|---|---|---|---|---|
|BASE TABLE|InnoDB|Dynamic|utf8mb4_0900_ai_ci||

**Columns**
|Name|Type|Nullable|Default|Charset|Collation|Key|Extra|Comment|
|---|---|---|---|---|---|---|---|---|
|id|int|NO||||PRI|auto_increment||
|amount|decimal(10,2)|NO|||||||
|status|varchar(10)|NO|'new'|utf8mb4|utf8mb4_0900_ai_ci||||
|note|text|YES|NULL|utf8mb4|utf8mb4_0900_ai_ci||||

 
## paid_orders
**Information**
|Table type|Charset|Collate|
|---|---|---|
|VIEW|latin1|latin1_swedish_ci|

**View Create SQL**

```sql
CREATE ALGORITHM=UNDEFINED DEFINER=`root`@`localhost` SQL SECURITY DEFINER VIEW `paid_orders` AS select `orders`.`id` AS `id`,`orders`.`amount` AS `amount` from `orders` where (`orders`.`status` = 'paid')
```
 
