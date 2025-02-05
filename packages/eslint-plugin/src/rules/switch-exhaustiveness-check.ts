import type { TSESLint, TSESTree } from '@typescript-eslint/utils';
import { getSourceCode } from '@typescript-eslint/utils/eslint-utils';
import * as tsutils from 'ts-api-utils';
import * as ts from 'typescript';

import {
  createRule,
  getConstrainedTypeAtLocation,
  getParserServices,
  isClosingBraceToken,
  isOpeningBraceToken,
  requiresQuoting,
} from '../util';

type MessageIds = 'switchIsNotExhaustive' | 'addMissingCases';
type Options = [
  {
    /**
     * If `true`, require a `default` clause for switches on non-union types.
     *
     * @default false
     */
    requireDefaultForNonUnion?: boolean;
  },
];

export default createRule<Options, MessageIds>({
  name: 'switch-exhaustiveness-check',
  meta: {
    type: 'suggestion',
    docs: {
      description: 'Require switch-case statements to be exhaustive',
      requiresTypeChecking: true,
    },
    hasSuggestions: true,
    schema: [
      {
        type: 'object',
        additionalProperties: false,
        properties: {
          requireDefaultForNonUnion: {
            description: `If 'true', require a 'default' clause for switches on non-union types.`,
            type: 'boolean',
          },
        },
      },
    ],
    messages: {
      switchIsNotExhaustive:
        'Switch is not exhaustive. Cases not matched: {{missingBranches}}',
      addMissingCases: 'Add branches for missing cases.',
    },
  },
  defaultOptions: [{ requireDefaultForNonUnion: false }],
  create(context, [{ requireDefaultForNonUnion }]) {
    const sourceCode = getSourceCode(context);
    const services = getParserServices(context);
    const checker = services.program.getTypeChecker();
    const compilerOptions = services.program.getCompilerOptions();

    function fixSwitch(
      fixer: TSESLint.RuleFixer,
      node: TSESTree.SwitchStatement,
      missingBranchTypes: (ts.Type | null)[], // null means default branch
      symbolName?: string,
    ): TSESLint.RuleFix {
      const lastCase =
        node.cases.length > 0 ? node.cases[node.cases.length - 1] : null;
      const caseIndent = lastCase
        ? ' '.repeat(lastCase.loc.start.column)
        : // if there are no cases, use indentation of the switch statement
          // and leave it to user to format it correctly
          ' '.repeat(node.loc.start.column);

      const missingCases = [];
      for (const missingBranchType of missingBranchTypes) {
        if (missingBranchType == null) {
          missingCases.push(`default: { throw new Error('default case') }`);
          continue;
        }
        // While running this rule on checker.ts of TypeScript project
        // the fix introduced a compiler error due to:
        //
        // type __String = (string & {
        //         __escapedIdentifier: void;
        //     }) | (void & {
        //         __escapedIdentifier: void;
        //     }) | InternalSymbolName;
        //
        // The following check fixes it.
        if (missingBranchType.isIntersection()) {
          continue;
        }

        const missingBranchName = missingBranchType.getSymbol()?.escapedName;
        let caseTest = checker.typeToString(missingBranchType);

        if (
          symbolName &&
          (missingBranchName || missingBranchName === '') &&
          requiresQuoting(missingBranchName.toString(), compilerOptions.target)
        ) {
          const escapedBranchName = missingBranchName
            .replace(/'/g, "\\'")
            .replace(/\n/g, '\\n')
            .replace(/\r/g, '\\r');

          caseTest = `${symbolName}['${escapedBranchName}']`;
        }

        const errorMessage = `Not implemented yet: ${caseTest} case`;
        const escapedErrorMessage = errorMessage.replace(/'/g, "\\'");

        missingCases.push(
          `case ${caseTest}: { throw new Error('${escapedErrorMessage}') }`,
        );
      }

      const fixString = missingCases
        .map(code => `${caseIndent}${code}`)
        .join('\n');

      if (lastCase) {
        return fixer.insertTextAfter(lastCase, `\n${fixString}`);
      }

      // there were no existing cases
      const openingBrace = sourceCode.getTokenAfter(
        node.discriminant,
        isOpeningBraceToken,
      )!;
      const closingBrace = sourceCode.getTokenAfter(
        node.discriminant,
        isClosingBraceToken,
      )!;

      return fixer.replaceTextRange(
        [openingBrace.range[0], closingBrace.range[1]],
        ['{', fixString, `${caseIndent}}`].join('\n'),
      );
    }

    function checkSwitchExhaustive(node: TSESTree.SwitchStatement): void {
      const discriminantType = getConstrainedTypeAtLocation(
        services,
        node.discriminant,
      );
      const symbolName = discriminantType.getSymbol()?.escapedName;

      if (discriminantType.isUnion()) {
        const unionTypes = tsutils.unionTypeParts(discriminantType);
        const caseTypes = new Set<ts.Type>();
        for (const switchCase of node.cases) {
          if (switchCase.test == null) {
            // Switch has 'default' branch - do nothing.
            return;
          }

          caseTypes.add(
            getConstrainedTypeAtLocation(services, switchCase.test),
          );
        }

        const missingBranchTypes = unionTypes.filter(
          unionType => !caseTypes.has(unionType),
        );

        if (missingBranchTypes.length === 0) {
          // All cases matched - do nothing.
          return;
        }

        context.report({
          node: node.discriminant,
          messageId: 'switchIsNotExhaustive',
          data: {
            missingBranches: missingBranchTypes
              .map(missingType =>
                tsutils.isTypeFlagSet(missingType, ts.TypeFlags.ESSymbolLike)
                  ? `typeof ${missingType.getSymbol()?.escapedName as string}`
                  : checker.typeToString(missingType),
              )
              .join(' | '),
          },
          suggest: [
            {
              messageId: 'addMissingCases',
              fix(fixer): TSESLint.RuleFix {
                return fixSwitch(
                  fixer,
                  node,
                  missingBranchTypes,
                  symbolName?.toString(),
                );
              },
            },
          ],
        });
      } else if (requireDefaultForNonUnion) {
        const hasDefault = node.cases.some(
          switchCase => switchCase.test == null,
        );

        if (!hasDefault) {
          context.report({
            node: node.discriminant,
            messageId: 'switchIsNotExhaustive',
            data: {
              missingBranches: 'default',
            },
            suggest: [
              {
                messageId: 'addMissingCases',
                fix(fixer): TSESLint.RuleFix {
                  return fixSwitch(fixer, node, [null]);
                },
              },
            ],
          });
        }
      }
    }

    return {
      SwitchStatement: checkSwitchExhaustive,
    };
  },
});
