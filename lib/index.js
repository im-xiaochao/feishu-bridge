/**
 * Feishu bridge settings page, node half. The empty apply exists so the plugin
 * appears in the host cordis.yml / Loader; the browser half owns the tab
 * through exports["./client"], discovered from the package.json dsh.client
 * declaration. The `feishu-bridge` namespace the page edits is registered by
 * the bridge itself, so this surface package registers no namespace of its own.
 */
/** Host plugin body — no host-side behavior for this surface plugin. */
function apply() {}

export { apply };
