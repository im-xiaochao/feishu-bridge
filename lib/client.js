window.__ModuleLoader__.load({
	id: "feishu-bridge",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react_jsx_runtime = require("react/jsx-runtime");
		let primitives = require("@deepseek-ai/dsh-client-ui-primitives");

		//#region locales
		/** Dictionary for the bridge's settings tab. */
		const NS = "settings.feishuBridge";
		const en = {
			tab: "Feishu Bridge",
			title: "Feishu Bridge",
			description: "Bridge a Feishu group chat and the Main Bot's own chat, both ways.",
			appId: "App ID",
			appIdHint: "The Feishu app's App ID, starting with cli_. The bridge stays off while this is blank.",
			chatId: "Group chat ID",
			chatIdHint: "The Feishu group's chat_id, starting with oc_. The bridge stays off while this is blank.",
			pollSeconds: "Poll interval (seconds)",
			pollSecondsHint: "How often the group is polled. Values below 2 are raised to 2.",
			secret: "App Secret",
			secretHint: "Stored outside the settings file. Leave blank to keep the current secret.",
			secretSet: "A secret is configured.",
			secretUnset: "No secret is configured; the bridge cannot sign in.",
			secretRef: "Credential name",
			secretRefHint: "Name of the stored credential that holds the App Secret.",
			status: "Status",
			statusReady: "Configured.",
			statusOff: "Not configured — fill in the App ID and group chat ID to start the bridge.",
			statusWritable: "This deployment stores settings read-only.",
			overridden: "Overridden",
			reset: "Reset to default",
			readOnly: "This deployment stores settings read-only.",
			unavailable: "This plugin is not loaded, so it cannot be configured right now.",
			save: "Save",
			saving: "Saving…",
			saveFailed: "The deployment did not accept these values; they were left for you to correct.",
			invalidNumber: "Enter a number, or leave blank to use the default."
		};
		const zh = {
			tab: "飞书桥接",
			title: "飞书桥接",
			description: "把飞书群和管家对话接成双向通道：群里发的消息管家收得到，管家的回复也会回到群里。",
			appId: "App ID",
			appIdHint: "飞书自建应用的 App ID，cli_ 开头。留空则桥接不启动。",
			chatId: "群 chat_id",
			chatIdHint: "飞书群的 chat_id，oc_ 开头。留空则桥接不启动。",
			pollSeconds: "轮询间隔（秒）",
			pollSecondsHint: "多久拉取一次群消息，小于 2 会被抬到 2。",
			secret: "App Secret",
			secretHint: "不写入设置文件。留空表示保持当前密钥。",
			secretSet: "已配置密钥。",
			secretUnset: "未配置密钥；桥接无法登录。",
			secretRef: "凭据名",
			secretRefHint: "存放 App Secret 的凭据条目名。",
			status: "当前状态",
			statusReady: "已配置，桥接将启动。",
			statusOff: "未配置 —— 填好 App ID 和群 chat_id 后桥接才会启动。",
			statusWritable: "本部署的设置为只读。",
			overridden: "已覆盖",
			reset: "恢复默认",
			readOnly: "本部署的设置为只读。",
			unavailable: "该插件当前未加载，暂时无法配置。",
			save: "保存",
			saving: "保存中…",
			saveFailed: "本部署没有接受这些值，已保留供你修改。",
			invalidNumber: "请填数字；留空表示使用默认值。"
		};
		/** Copy the shared form frame renders. */
		function formLabels(t) {
			return {
				unavailable: t("unavailable"),
				readOnly: t("readOnly"),
				saveFailed: t("saveFailed"),
				save: t("save"),
				saving: t("saving")
			};
		}
		//#endregion

		//#region controller
		/**
		 * The bridge's staged form over its own `feishu-bridge` settings namespace.
		 *
		 * The App Secret is the one control that does not live in the section: its
		 * literal never rides a response, so the page learns only whether one is
		 * configured and writes it through the credentials domain. Volatile fields
		 * (appId / chatId) are the ones the settings write gate accepts, so a save
		 * that changes only pollSeconds still lands.
		 */
		var FeishuBridgeCardController = class {
			scope;
			ctx;
			form;
			store;
			unsubscribe;
			credential = { ref: "", configured: false, writable: true };

			constructor(scope, ctx) {
				this.scope = scope;
				this.ctx = ctx;
				this.form = new primitives.SettingsFormModel(
					scope,
					[
						primitives.settingsTextField("appId"),
						primitives.settingsTextField("chatId"),
						primitives.settingsNumberField("pollSeconds"),
						primitives.settingsTextField("secretName")
					],
					[{ field: "appSecret", write: (text) => this.writeSecret(text) }]
				);
				this.store = this.form.bind(() => this.projection());
				this.unsubscribe = scope.subscribe(() => { this.readCredential(); });
				this.readCredential();
			}

			/** The credential name the section currently declares, or the plugin default. */
			credentialRef() {
				const declared = this.scope.getSnapshot()?.value?.secretName;
				return typeof declared === "string" && declared.length > 0 ? declared : "FEISHU_APP_SECRET";
			}

			projection() {
				// The status line follows what the form currently shows, not only what is
				// already saved: a user who has just typed both ids should see it go ready
				// before pressing save. `field()` returns the staged draft when there is one.
				const appId = this.form.field("appId");
				const chatId = this.form.field("chatId");
				return {
					...this.form.shell(),
					appId,
					chatId,
					pollSeconds: this.form.field("pollSeconds"),
					secretName: this.form.field("secretName"),
					appSecret: this.form.field("appSecret"),
					secretConfigured: this.credential.configured,
					secretWritable: this.credential.writable,
					ready: appId.text !== "" && chatId.text !== ""
				};
			}

			/**
			 * Ask the credentials domain about the reference the section names. A
			 * response is published only while it still answers for the reference in
			 * force, because `secretName` can change between request and response.
			 */
			async readCredential() {
				const ref = this.credentialRef();
				if (ref !== this.credential.ref) {
					this.credential = { ref, configured: false, writable: true };
					this.store.set(this.projection());
				}
				try {
					const response = await this.ctx.remote.credentials.describe([ref]);
					if (!response.ok || ref !== this.credentialRef()) return;
					const view = response.value[ref];
					const next = {
						ref,
						configured: view?.configured ?? false,
						writable: view?.writable ?? true
					};
					if (next.configured === this.credential.configured
						&& next.writable === this.credential.writable) return;
					this.credential = next;
					this.store.set(this.projection());
				} catch {
					// A deployment without the credentials domain keeps the last answer.
				}
			}

			/** Re-read after the Host reports a change to the reference this page watches. */
			refreshCredential(ref) {
				if (ref !== this.credentialRef()) return;
				this.readCredential();
			}

			/** The face the slot registration injects. */
			inject() {
				return { hooks: { feishuBridgeCard: this.store }, ...this.form.actions() };
			}

			/** Write the staged secret; a blank draft writes nothing. */
			async writeSecret(value) {
				if (typeof value !== "string" || value.trim() === "") return this.credential.configured;
				await this.ctx.remote.credentials.set(this.credentialRef(), value);
				await this.readCredential();
				return this.credential.configured;
			}

			dispose() {
				this.unsubscribe();
				this.form.dispose();
			}
		};
		//#endregion

		//#region card
		/** The bridge's settings panel: connection status, the two ids, and the secret. */
		function FeishuBridgeCard(props) {
			const { t } = props;
			const state = props.useFeishuBridgeCard((snapshot) => snapshot);
			if (props.view === "summary") return t("description");
			const disabled = !state.writable;
			return (0, react_jsx_runtime.jsx)(primitives.SettingsForm, {
				labels: formLabels(t),
				state,
				onSave: props.save,
				onDiscard: props.discard,
				children: (0, react_jsx_runtime.jsxs)("div", {
					children: [
						(0, react_jsx_runtime.jsx)("p", {
							className: "feishu-bridge-status",
							role: "status",
							children: state.ready ? t("statusReady") : t("statusOff")
						}),
						(0, react_jsx_runtime.jsx)(primitives.SettingsValueField, {
							id: "plugin-config-feishu-app-id",
							label: t("appId"),
							hint: t("appIdHint"),
							overriddenLabel: t("overridden"),
							resetLabel: t("reset"),
							invalidLabel: t("invalidNumber"),
							disabled,
							...state.appId,
							onEdit: (text) => { props.edit("appId", text); },
							onReset: () => { props.resetField("appId"); }
						}),
						(0, react_jsx_runtime.jsx)(primitives.SettingsValueField, {
							id: "plugin-config-feishu-chat-id",
							label: t("chatId"),
							hint: t("chatIdHint"),
							overriddenLabel: t("overridden"),
							resetLabel: t("reset"),
							invalidLabel: t("invalidNumber"),
							disabled,
							...state.chatId,
							onEdit: (text) => { props.edit("chatId", text); },
							onReset: () => { props.resetField("chatId"); }
						}),
						(0, react_jsx_runtime.jsx)(primitives.SettingsValueField, {
							id: "plugin-config-feishu-poll-seconds",
							label: t("pollSeconds"),
							hint: t("pollSecondsHint"),
							overriddenLabel: t("overridden"),
							resetLabel: t("reset"),
							invalidLabel: t("invalidNumber"),
							numeric: true,
							disabled,
							...state.pollSeconds,
							onEdit: (text) => { props.edit("pollSeconds", text); },
							onReset: () => { props.resetField("pollSeconds"); }
						}),
						(0, react_jsx_runtime.jsx)(primitives.SettingsValueField, {
							id: "plugin-config-feishu-secret-name",
							label: t("secretRef"),
							hint: t("secretRefHint"),
							overriddenLabel: t("overridden"),
							resetLabel: t("reset"),
							invalidLabel: t("invalidNumber"),
							disabled,
							...state.secretName,
							onEdit: (text) => { props.edit("secretName", text); },
							onReset: () => { props.resetField("secretName"); }
						}),
						(0, react_jsx_runtime.jsx)(primitives.SettingsSecretField, {
							id: "plugin-config-feishu-app-secret",
							label: t("secret"),
							hint: t("secretHint"),
							disabled: !state.secretWritable,
							text: state.appSecret.text,
							configured: state.secretConfigured,
							stateLabel: state.secretConfigured ? t("secretSet") : t("secretUnset"),
							onEdit: (text) => { props.edit("appSecret", text); }
						})
					]
				})
			});
		}
		//#endregion

		//#region apply
		/** Namespace of this plugin's own Host entry — the settings scope the page edits. */
		const BRIDGE_NS = "feishu-bridge";
		/** Required services (cordis fiber inject). */
		const inject = ["slots", "locale", "remote", "remote.credentials", "configForms"];

		/** Mount the bridge's tab inside Settings → Built-in plugins. */
		function apply(ctx) {
			const t = ctx.locale.bind(NS);
			ctx.effect(() => ctx.locale.register(NS, { zh, en }), "feishu-bridge: dictionaries");
			const card = new FeishuBridgeCardController(ctx.configForms.get(BRIDGE_NS), ctx);
			ctx.effect(() => () => { card.dispose(); }, "feishu-bridge: form subscription");
			ctx.effect(() => ctx.remote.$on("credentials/reference-updated", (ref) => {
				card.refreshCredential(ref);
			}), "feishu-bridge: credential invalidations");
			ctx.effect(() => ctx.configForms.whileServed([BRIDGE_NS], () => ctx.slots.inject("settings.plugins.tab", () => ctx.slots.register({
				name: "settings.plugins.tab",
				id: "feishu-bridge",
				order: 60,
				label: () => t("tab"),
				locale: NS,
				inject: () => card.inject()
			}, FeishuBridgeCard))), "feishu-bridge: settings tab");
		}
		//#endregion

		exports.apply = apply;
		exports.inject = inject;
		exports.NS = NS;
		return module.exports;
	}
});

