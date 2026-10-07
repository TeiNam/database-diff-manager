shop 
=============

## Table List
- [orders ()](#orders)
- [items ()](#items)
 
## orders
**Information**
|Table type|Engine|Row format|Collate|Comment|
|---|---|---|---|---|
|BASE TABLE|InnoDB|Dynamic|utf8mb4_0900_ai_ci||

**Columns**
|Name|Type|Nullable|Default|Charset|Collation|Key|Extra|Comment|
|---|---|---|---|---|---|---|---|---|
|id|bigint unsigned|NO||||PRI|auto_increment||
|code|varchar(20)|NO||latin1|latin1_swedish_ci|UNI|||
|amt|int|NO||||MUL|||
|total|bigint|YES|||||VIRTUAL GENERATED||
|memo|varchar(20)|YES||utf8mb4|utf8mb4_0900_ai_ci|MUL|||
|note|varchar(10)|YES||utf8mb4|utf8mb4_0900_ai_ci||||

**Index**
- [Normal]uk_code(code)
- [Normal]ix_memo(memo,amt)

## items
**Information**
|Table type|Engine|Row format|Collate|Comment|
|---|---|---|---|---|
|BASE TABLE|InnoDB|Dynamic|utf8mb4_0900_ai_ci||

**Columns**
|Name|Type|Nullable|Default|Charset|Collation|Key|Extra|Comment|
|---|---|---|---|---|---|---|---|---|
|id|int|NO||||PRI|||
|name|varchar(30)|NO||utf8mb4|utf8mb4_0900_ai_ci||||
|dbl|int|YES|||||STORED GENERATED||

