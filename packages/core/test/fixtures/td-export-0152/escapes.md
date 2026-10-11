tdm_md 
=============

## Table List
- [esc ()](#esc)
 - [Order Items (a \* b \<i>x\</i>)](#order items)
 
## esc
**Information**
|Table type|Engine|Row format|Collate|Comment|
|---|---|---|---|---|
|BASE TABLE|InnoDB|Dynamic|utf8mb4_0900_ai_ci||

**Columns**
|Name|Type|Nullable|Default|Charset|Collation|Key|Extra|Comment|
|---|---|---|---|---|---|---|---|---|
|id|int|NO||||PRI|||
|path|varchar(50)|NO|'C:\\\\temp'|utf8mb4|utf8mb4_0900_ai_ci|MUL|||
|nl|varchar(20)|YES|'a\\nb'|utf8mb4|utf8mb4_0900_ai_ci||||
|star|varchar(20)|YES|'\*x\*'|utf8mb4|utf8mb4_0900_ai_ci|||see [doc]\(http://e.x) \`code\` \<b>|
|pipe|enum('a\|b','c')|YES|'a\|b'|utf8mb4|utf8mb4_0900_ai_ci||||
|g1|varchar(40)|YES||utf8mb4|utf8mb4_0900_ai_ci||VIRTUAL GENERATED concat(\`path\`,_utf8mb4\\'invisible\\')||
|g2|int|YES|||||STORED GENERATED INVISIBLE (\`id\` \* 2)||
|hid|int|YES|NULL||||INVISIBLE||

**Index**
- [Normal]fx(lower(\`path\`))
- [Normal]ix\*1(path)

 
## order items
**Information**
|Table type|Engine|Row format|Collate|Comment|
|---|---|---|---|---|
|BASE TABLE|InnoDB|Dynamic|utf8mb4_0900_ai_ci|a \* b \<i>x\</i>|

**Columns**
|Name|Type|Nullable|Default|Charset|Collation|Key|Extra|Comment|
|---|---|---|---|---|---|---|---|---|
|id|int|NO||||PRI|||
|qty|int|NO|1||||||

 
