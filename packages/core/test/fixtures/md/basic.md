shop 
=============

## Table List
- [Orders (주문)](#orders)
 - [v_sales ()](#v_sales)
 
## orders
**Information**
|Table type|Engine|Row format|Collate|Comment|
|---|---|---|---|---|
|BASE TABLE|InnoDB|Dynamic|utf8mb4_0900_ai_ci|주문|

**Columns**
|Name|Type|Nullable|Default|Charset|Collation|Key|Extra|Comment|
|---|---|---|---|---|---|---|---|---|
|id|bigint unsigned|NO||||PRI|auto_increment|주문 ID|
|user_id|int unsigned|NO||||MUL|||
|status|varchar(20)|NO|ready|utf8mb4|utf8mb4_0900_ai_ci||||
|memo|text|YES||utf8mb4|utf8mb4_0900_ai_ci|||a|b 메모|
|note|varchar(10)|YES||utf8mb4|utf8mb4_0900_ai_ci||||
|code|varchar(5)|NO||utf8mb4|utf8mb4_0900_ai_ci||||
|flag|bit(1)|NO|b'0'|||||
|uid|varchar(36)|NO|uuid()||||DEFAULT_GENERATED||
|ts|datetime(3)|NO|CURRENT_TIMESTAMP(3)|||||
|vc|int|YES|||||VIRTUAL GENERATED||
|sc|int|YES|||||STORED GENERATED||
|rem|varchar(10)|YES||utf8mb4|utf8mb4_0900_ai_ci|||line1
line2 끝|
|created_at|datetime|NO|CURRENT_TIMESTAMP|||PRI|DEFAULT_GENERATED on update CURRENT_TIMESTAMP||

**Index**
- [Unique]uk_status(status,user_id)
- [Normal]ix_user(user_id)

**Constraint**
- fk_user FOREIGN KEY (user_id) Reference users.id ON DELETE CASCADE ON UPDATE NO ACTION
- fk_pair FOREIGN KEY (status,user_id) Reference users.a ON DELETE CASCADE ON UPDATE NO ACTION
- fk_pair FOREIGN KEY (status,user_id) Reference users.b ON DELETE CASCADE ON UPDATE NO ACTION
- fk_pair FOREIGN KEY (status,user_id) Reference users.b ON DELETE CASCADE ON UPDATE NO ACTION

 
## v_sales
**Information**
|Table type|Charset|Collate|
|---|---|---|
|VIEW|utf8mb4|utf8mb4_0900_ai_ci|

**View Create SQL**

```sql
CREATE ALGORITHM=UNDEFINED DEFINER=`root`@`%` SQL SECURITY DEFINER VIEW `v_sales` AS select `orders`.`id` AS `id` from `orders`
```
 

## broken
**Information**
|Table type|Engine|Row format|Collate|Comment|
|---|---|---|---|---|
|BASE TABLE|InnoDB|Dynamic|utf8mb4_0900_ai_ci||
