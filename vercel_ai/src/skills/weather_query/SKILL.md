# 天气查询 (tianqi_chaxun)

一个模拟查询指定城市和日期天气的 Skill。

## 输入参数

`skill_run` 的 `input` 参数为一个 JSON 对象，包含：

- `address` (string): 必填，要查询的地址/城市。
- `date` (string): 必填，要查询的日期。

## 示例

```json
{
  "name": "tianqi_chaxun",
  "input": {
    "address": "北京",
    "date": "2024-05-21"
  }
}
```

## 输出

返回一个包含模拟天气信息的对象。

```json
{
  "text": "2024-05-21，北京的天气为：晴，气温 20°C - 28°C。"
}
```
