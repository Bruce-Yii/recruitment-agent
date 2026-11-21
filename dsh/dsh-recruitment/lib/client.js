window.__ModuleLoader__.load({
	id: "@recruitment/dsh-recruitment",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		// src/client/index.tsx
		/** Cordis 客户端插件依赖声明（旧侧栏退役后无需注入 `slots` 服务）。 */
		const inject = [];
		/**
		* DSH 浏览器插件空操作入口（不再注册旧 RecruitmentShell 侧栏与主面板）。
		*/
		function apply() {}
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
