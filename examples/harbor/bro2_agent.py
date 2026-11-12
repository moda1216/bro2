"""
bro2 · Harbor 自定义 agent 接入口（v2.29.0 / P0-01）

把 bro2 接成 Harbor 的「已安装 agent」（BaseInstalledAgent）：Harbor 在任务容器里安装并
运行 bro2 CLI，bro2 的 agent 循环在容器内跑、对 /app 有文件系统访问、产出任务文件，
Harbor 收集日志并转成标准化轨迹。这样 bro2 就能和 mini-swe-agent / Terminus-2 在
**同一模型、同一任务、同一预算、同一评分器**下被 Harbor 统一调度出对照数。

契约依据：Harbor 文档 core-concepts/agents/custom-agents —— 自定义 agent 优先用
BaseInstalledAgent（install 装 CLI，run 在容器内执行），通过 `-a module.path:ClassName`
传入；agent 循环必须留在任务环境内时用 BaseAgent。bro2 的循环应留在容器内，故用前者。

> 诚实边界（接入口自身不产分）：本文件是**协议接入口**，证明 bro2 可被 Harbor 装载；
> 真实能力对照需要（1）Harbor 运行时 +（2）一个可工具调用的模型端点。两者都不在本沙箱内
> 默认具备。确定性 mock 验证（examples/harbor-verify.ts）只验证接线正确性（同一任务子集 /
> 同一预算 / 同一评分器三方对齐），**不反映 harness 价值、不写 external-results.json、
> 不改 L4 / leadership.verdict**。
"""

from __future__ import annotations

import shlex

from harbor.agents.installed.base import BaseInstalledAgent, with_prompt_template
from harbor.agents.agent_auth_resolution import ModelConnectionSpec, ProviderAccess
from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext
from harbor.models.model_api_format import ModelApiFormat


class Bro2Agent(BaseInstalledAgent):
    """bro2 作为 Harbor 已安装 agent：容器内跑 bro2 CLI 完成 Terminal-Bench 类任务。"""

    # ---- 基础元数据 ----------------------------------------------------------
    @staticmethod
    def name() -> str:
        return "bro2"

    def version(self) -> str | None:
        return "2.29.0"

    # ---- 鉴权透传：bro2 用自身 agentos.config.json 的免 Key 端点（kilo 等）----
    # Harbor 把用户传入的模型 slug 原样透传给 bro2（self.model_name），bro2 再按自己的
    # provider 配置解析；不强制要求 API Key（apiKeyOptional 端点走匿名通道）。
    MODEL_CONNECTION = ModelConnectionSpec(
        default_provider="openai",
        agent_provider_access=ProviderAccess(
            api_key_candidate_names=["AGENTOS_LIVE_API_KEY", "OPENAI_API_KEY"],
            base_url_candidate_names=["AGENTOS_LIVE_BASE_URL"],
        ),
        supported_api_formats=[ModelApiFormat.OPENAI_CHAT_COMPLETIONS],
        default_api_format_by_provider={
            "default": ModelApiFormat.OPENAI_CHAT_COMPLETIONS,
        },
    )

    # ---- 安装：在任务容器内装好 Node + bro2 -----------------------------------
    # Harbor 通过 --ak skip_install=true 跳过 install 时，configure() 会重新基于已安装
    # 文件重建内存状态，故重活（装 Node、拷 bro2 源码）放 install，每 trial 必跑的轻活放
    # configure（本 agent 无需，留空默认实现）。
    async def install(self, environment: BaseEnvironment) -> None:
        # 任务容器通常是 python:3.x-slim，未必带 Node。用系统包管理器装 Node 20+。
        # 命令失败会冒泡，由 Harbor 判为该 trial 安装失败（不污染评分）。
        await self.exec_as_root(
            environment,
            command="bash -lc 'command -v node >/dev/null 2>&1 || "
            "(apt-get update -qq && apt-get install -y -qq nodejs npm >/dev/null 2>&1) || "
            "(command -v apk >/dev/null && apk add --no-cache nodejs npm)'",
        )
        # bro2 源码由 Harbor 的 agent 挂载机制放进 /app/bro2（或在 configure 阶段写入）；
        # 这里确保依赖就绪（bro2 零运行时第三方依赖，只需 TypeScript strip 支持，Node 22+ 原生）。
        await self.exec_as_agent(
            environment,
            command="cd /app/bro2 && node --version && npm --version",
        )

    # ---- 运行：把上游 instruction 交给 bro2 循环 ---------------------------------
    # with_prompt_template 让 instruction 经 Harbor 的 prompt 模板渲染后传入；bro2 侧还会
    # 追加一段显式标注的 [harness adapter] 路径适配说明（见 external-measure.ts 的 ENV_NOTE），
    # 两个 arm 完全一致、不篡改公开任务原文。
    @with_prompt_template
    async def run(
        self,
        instruction: str,
        environment: BaseEnvironment,
        context: AgentContext,
    ) -> None:
        # 预算与治理：max-steps 与 external:measure 的 MAX_MODEL_CALLS 对齐（默认 12），
        # --auto-approve 让 bro2 在容器内无人值守跑完（Harbor 容器不交互）。
        # 模型由 Harbor 透传的 self.model_name 决定；bro2 按 agentos.config.json 解析。
        cmd = (
            "cd /app/bro2 && node --experimental-strip-types --no-warnings "
            "bin/agentos.ts run "
            f"--task {shlex.quote(instruction)} "
            "--preset standard --auto-approve --quiet"
        )
        await self.exec_as_agent(environment, command=cmd)
