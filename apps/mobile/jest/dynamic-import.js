// Metro keeps import() for lazy loading, but Node only runs it in ES modules. Tests turn it into a
// promise of require(), which also lets jest.mock() stand in for the module.
module.exports = ({ types: t }) => ({
  name: 'jest-dynamic-import',
  visitor: {
    CallExpression(path) {
      if (path.node.callee.type !== 'Import') return;
      const resolved = t.callExpression(
        t.memberExpression(t.identifier('Promise'), t.identifier('resolve')),
        [],
      );
      const load = t.arrowFunctionExpression(
        [],
        t.callExpression(t.identifier('require'), path.node.arguments),
      );
      path.replaceWith(
        t.callExpression(t.memberExpression(resolved, t.identifier('then')), [load]),
      );
    },
  },
});
