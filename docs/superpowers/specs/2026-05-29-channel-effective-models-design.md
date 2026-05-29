# 渠道有效模型设计

## 目标

渠道模型路由改为“自动验证模型 + 手动正式模型 - 待加入模型 - 手动排除”。上游模型发现仍用于自动验证和展示来源；空渠道首次拉取到的模型直接进入正式，已有模型的渠道后续发现的新模型先进入待加入，不直接进入路由；抓不到但实际可用的模型可以在渠道编辑中手动加入当前渠道。

## 模型来源

- `channel_model_capabilities` 中 `last_ok_at > 0` 的模型是自动验证通过模型。
- `channels.metadata_json.manual_include_models` 保存人工正式模型。
- `channels.metadata_json.manual_pending_models` 保存待加入模型。
- `channels.metadata_json.manual_exclude_models` 保存人工排除模型。
- `channels.models_json` 保存上游发现模型，并作为旧数据兼容兜底：当渠道没有验证通过模型，也没有任何手动 include/pending/exclude 配置时，才继续作为有效模型来源。

有效模型计算公式：

```text
effective_models = (verified_models union manual_include_models) - manual_pending_models - manual_exclude_models
```

## 行为

- 模型广场只读展示模型在各渠道中的正式、待加入和已排除状态，用于全局检索和总览。
- 渠道编辑弹窗负责当前渠道的模型管理，提供拉取模型、手动添加、加入正式、转待加入、排除和删除操作。删除会清除该渠道上的手动状态、已发现模型记录和验证能力记录；排除则保留为显式黑名单。
- `GET /v1/models`、New API 兼容模型接口和代理路由统一使用有效模型。
- 自动更新渠道模型时继续更新发现模型、调用令牌模型和验证能力表；如果刷新前渠道没有模型且没有任何人工模型状态，本次发现模型写入正式；否则新发现且未被人工设置过的模型写入待加入。
- 站点编辑表单不再暴露换行文本框，模型状态在对应渠道编辑弹窗中维护。
- 备份仍通过 `metadata_json` 保留人工配置，不新增数据库迁移。

## 测试

- 有效模型计算覆盖合并、待加入过滤、排除、去重、旧 `models_json` 兜底。
- 路由候选过滤覆盖手动补充可路由、手动排除不可路由、抓取列表不再默认污染路由。
- OpenAI 模型列表覆盖有效模型聚合。
- 站点 metadata 保存覆盖 include/pending/exclude 不被站点类型更新清除。
