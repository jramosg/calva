import * as vscode from 'vscode';
import * as util from './utilities';
import * as docMirror from './doc-mirror/index';
import { EditableDocument, ModelEdit } from './cursor-doc/model';
import * as select from './select';
import * as printer from './printer';
import { _semiColonWouldBreakStructureWhere } from './cursor-doc/paredit';
import * as format from './calva-fmt/src/format';
import { calculateCommentPrefixRemovalEnd, findCommentPrefixStart } from './comment-prefix';

// Relies on that `when` claus guards this from being called
// when the cursor is before the comment marker
export function continueCommentCommand() {
  const document = util.tryToGetDocument({});
  if (document && document.languageId === 'clojure') {
    const editor = util.getActiveTextEditor();
    const position = editor.selections[0].active;
    const cursor = docMirror.getDocument(document).getTokenCursor();
    if (cursor.getToken().type !== 'comment') {
      if (cursor.getPrevToken().type === 'comment') {
        cursor.previous();
      } else {
        return;
      }
    }
    const commentOffset = cursor.rowCol[1];
    const commentText = cursor.getToken().raw;
    const [_1, startText, bullet, num] = commentText.match(/^([;\s]+)([*-] +|(\d+)\. +)?/) ?? [];
    const newNum = num ? parseInt(num) + 1 : undefined;
    const bulletText = newNum ? bullet.replace(/\d+/, '' + newNum) : bullet;
    const pad = ' '.repeat(commentOffset);
    const newText = `${pad}${startText}${bullet ? bulletText : ''}`;
    void editor
      .edit((edits) => edits.insert(position, `\n${newText}`), {
        undoStopAfter: false,
        undoStopBefore: true,
      })
      .then((fulfilled) => {
        if (fulfilled) {
          const newPosition = position.with(position.line + 1, newText.length);
          editor.selections = [new vscode.Selection(newPosition, newPosition)];
        }
      });
  }
}

function getAffectedLineNumbers(editor: vscode.TextEditor, lineCount: number): number[] {
  const affectedLines = new Set<number>();
  for (const selection of editor.selections) {
    for (let line = selection.start.line; line <= selection.end.line; line++) {
      affectedLines.add(line);
    }
  }
  return Array.from(affectedLines)
    .filter((lineNum) => lineNum >= 0 && lineNum < lineCount)
    .sort((a, b) => a - b);
}

/**
 * Builds candidate positions where a comment prefix might start on a line:
 * first non-whitespace, then any selection start columns past that point.
 */
function commentCandidatePositions(
  firstNonWhitespace: number,
  lineNum: number,
  selections?: readonly vscode.Selection[]
): number[] {
  const positions = [firstNonWhitespace];
  if (selections) {
    for (const sel of selections) {
      if (sel.start.line === lineNum && sel.start.character > firstNonWhitespace) {
        positions.push(sel.start.character);
      }
    }
  }
  return positions;
}

function areAllNonEmptyTargetLinesCommented(
  document: vscode.TextDocument,
  lineNumbers: number[],
  candidatesMap: Map<number, number[]>
): boolean {
  const nonEmptyLines = lineNumbers.filter(
    (lineNum) => !document.lineAt(lineNum).isEmptyOrWhitespace
  );
  return (
    nonEmptyLines.length > 0 &&
    nonEmptyLines.every((lineNum) => {
      const candidates = candidatesMap.get(lineNum) ?? [];
      return findCommentPrefixStart(document.lineAt(lineNum).text, candidates) !== undefined;
    })
  );
}

/**
 * Inserts `;; ` comment prefixes for a single selection, using structural
 * analysis to push closing delimiters to new lines when a semicolon would
 * break form balance. Then reformats enclosing forms.
 */
async function applyStructuralCommentsToSingleSelectionLines(
  editor: vscode.TextEditor,
  affectedLineNumbers: number[]
) {
  const originalSelections = [...editor.selections];
  const singleSelection = editor.selections[0];
  const partialSelectionStartColumn =
    !singleSelection.isEmpty && affectedLineNumbers.length > 1
      ? singleSelection.start.character
      : undefined;
  const descendingLineNumbers = [...new Set(affectedLineNumbers)].sort((a, b) => b - a);
  const affectedLineSet = new Set(affectedLineNumbers);
  const originalFirstNonWSMap = new Map<number, number>();
  const originalInsertionColumnMap = new Map<number, number>();
  let partialSelectionStartOffset: number | undefined;
  let alignedCommentColumn: number | undefined;

  // Calculate aligned comment column and store original indentation.
  for (const lineNum of affectedLineNumbers) {
    const line = editor.document.lineAt(lineNum);
    const firstNonWhitespace = line.firstNonWhitespaceCharacterIndex;
    originalFirstNonWSMap.set(lineNum, firstNonWhitespace);

    let insertionColumnCandidate = firstNonWhitespace;
    if (
      lineNum === singleSelection.start.line &&
      !singleSelection.isEmpty &&
      singleSelection.start.character > firstNonWhitespace
    ) {
      insertionColumnCandidate = singleSelection.start.character;
      if (affectedLineNumbers.length > 1) {
        partialSelectionStartOffset = editor.document.offsetAt(
          new vscode.Position(lineNum, singleSelection.start.character)
        );
      }
    }
    originalInsertionColumnMap.set(lineNum, insertionColumnCandidate);

    if (!line.isEmptyOrWhitespace) {
      alignedCommentColumn =
        alignedCommentColumn === undefined
          ? insertionColumnCandidate
          : Math.min(alignedCommentColumn, insertionColumnCandidate);
    }
  }

  const resolvedAlignedCommentColumn = alignedCommentColumn ?? 0;

  const mirrorDoc = docMirror.getDocument(editor.document);
  const structureBreakLineNums = new Set<number>();

  // Single atomic edit for all comment insertions
  await editor.edit(
    (editBuilder) => {
      for (const lineNum of descendingLineNumbers) {
        const currentLine = editor.document.lineAt(lineNum);
        const firstNonWhitespace = originalFirstNonWSMap.get(lineNum) ?? 0;
        const rawInsertionColumn =
          affectedLineNumbers.length > 1
            ? resolvedAlignedCommentColumn
            : originalInsertionColumnMap.get(lineNum) ?? firstNonWhitespace;
        const firstLineInsertionColumn =
          partialSelectionStartColumn !== undefined && lineNum === singleSelection.start.line
            ? Math.max(rawInsertionColumn, partialSelectionStartColumn)
            : rawInsertionColumn;
        const insertionColumn = Math.min(firstLineInsertionColumn, currentLine.text.length);
        originalInsertionColumnMap.set(lineNum, insertionColumn);
        const insertionOffset = editor.document.offsetAt(
          new vscode.Position(lineNum, insertionColumn)
        );

        const wouldBreakWhere = _semiColonWouldBreakStructureWhere(mirrorDoc, insertionOffset);

        editBuilder.insert(new vscode.Position(lineNum, insertionColumn), ';; ');

        if (wouldBreakWhere !== false) {
          let breakOffset = wouldBreakWhere;
          let skipBreak = false;

          if (affectedLineNumbers.length > 1) {
            const resolvedBreakOffset = resolveStructuralBreakOffset(
              mirrorDoc,
              wouldBreakWhere,
              affectedLineSet,
              partialSelectionStartOffset
            );
            if (resolvedBreakOffset === false) {
              skipBreak = true;
            } else {
              breakOffset = resolvedBreakOffset;
            }
          }

          if (!skipBreak) {
            structureBreakLineNums.add(lineNum);
            const indent = currentLine.text.match(/^\s*/)[0];
            editBuilder.insert(editor.document.positionAt(breakOffset), '\n' + indent);
          }
        }
      }
    },
    {
      undoStopBefore: true,
      undoStopAfter: false,
    }
  );

  // Compute shifted line numbers (structure breaks insert newlines, pushing later lines down)
  const shiftedLineNumbers = affectedLineNumbers.map((lineNum) => {
    let shift = 0;
    for (const breakLineNum of structureBreakLineNums) {
      if (breakLineNum < lineNum) {
        shift++;
      }
    }
    return lineNum + shift;
  });

  // Save post-comment indentation before reformatting so adjustPosition can
  // compute how much each line shifted during reformatting.
  const postCommentFirstNonWSMap = new Map<number, number>();
  for (const lineNum of shiftedLineNumbers) {
    if (lineNum < editor.document.lineCount) {
      postCommentFirstNonWSMap.set(
        lineNum,
        editor.document.lineAt(lineNum).firstNonWhitespaceCharacterIndex
      );
    }
  }

  if (affectedLineNumbers.length > 1) {
    if (structureBreakLineNums.size > 0) {
      // Compute delimiter line numbers from structural breaks (these lines have actual
      // code tokens that collectEnclosingFormRanges can navigate from)
      const delimiterLineNumbers: number[] = [];
      {
        let shift = 0;
        for (const breakLineNum of structureBreakLineNums) {
          const delimiterLine = breakLineNum + shift + 1;
          shift++;
          if (delimiterLine < editor.document.lineCount) {
            delimiterLineNumbers.push(delimiterLine);
          }
        }
      }
      // Use getFormSelection (useCurrentForm=true) for delimiter lines so we reformat the
      // form being closed (e.g. (y ...)) rather than its parent (e.g. (x ...))
      await reformatEnclosingFormsForLines(
        editor,
        delimiterLineNumbers,
        { 'indent-line-comments?': false },
        true
      );
    } else {
      // No structural breaks — no reformatting needed, just close the undo group
      await editor.edit(() => undefined, { undoStopBefore: false, undoStopAfter: true });
    }
  } else {
    await reformatEnclosingFormsForLines(editor, shiftedLineNumbers);
  }

  function countInsertedLinesBefore(line: number): number {
    let inserted = 0;
    for (const breakLineNum of structureBreakLineNums) {
      if (breakLineNum < line) {
        inserted++;
      }
    }
    return inserted;
  }

  function adjustPosition(
    pos: vscode.Position,
    boundary: 'start' | 'end',
    selectionIsEmpty: boolean
  ): vscode.Position {
    const isSelectionStartAtInsertionColumn = (
      insertionColumn: number | undefined,
      position: vscode.Position
    ) => {
      return (
        !selectionIsEmpty &&
        boundary === 'start' &&
        insertionColumn !== undefined &&
        position.character === insertionColumn
      );
    };

    const shiftedLine = pos.line + countInsertedLinesBefore(pos.line);

    if (shiftedLine >= editor.document.lineCount) {
      return pos;
    }

    const line = editor.document.lineAt(shiftedLine);
    const newFirstNonWS = line.firstNonWhitespaceCharacterIndex;
    const lineContent = line.text.slice(newFirstNonWS);
    const insertionColumn = originalInsertionColumnMap.get(pos.line);

    // Compute how much this line shifted due to reformatting
    const preReformatFirstNonWS = postCommentFirstNonWSMap.get(shiftedLine);
    const reformatShift =
      preReformatFirstNonWS !== undefined ? newFirstNonWS - preReformatFirstNonWS : 0;

    if (isSelectionStartAtInsertionColumn(insertionColumn, pos)) {
      return new vscode.Position(shiftedLine, Math.max(0, insertionColumn + reformatShift));
    }

    if (lineContent.startsWith(';; ')) {
      const origFirstNonWS = originalFirstNonWSMap.get(pos.line) ?? pos.character;
      const baseColumnForOffset = insertionColumn ?? origFirstNonWS;
      const contentOffset = Math.max(0, pos.character - baseColumnForOffset);
      const newCol = Math.min(newFirstNonWS + 3 + contentOffset, line.text.length);
      return new vscode.Position(shiftedLine, newCol);
    }

    if (insertionColumn !== undefined && pos.character >= insertionColumn) {
      return new vscode.Position(
        shiftedLine,
        Math.min(pos.character + 3 + reformatShift, line.text.length)
      );
    }

    return new vscode.Position(shiftedLine, Math.min(pos.character, line.text.length));
  }

  editor.selections = originalSelections.map((selection) => {
    const newStart = adjustPosition(selection.start, 'start', selection.isEmpty);
    const newEnd = adjustPosition(selection.end, 'end', selection.isEmpty);
    const isReversed = selection.anchor.isAfter(selection.active);
    return isReversed
      ? new vscode.Selection(newEnd, newStart)
      : new vscode.Selection(newStart, newEnd);
  });
}

/**
 * Resolves where a structural break should be inserted (or if it can be skipped)
 * for multiline commenting.
 *
 * Returns:
 * - an offset where break should be inserted (possibly adjusted), or
 * - `false` when the break can be skipped entirely.
 */
function resolveStructuralBreakOffset(
  mirrorDoc: EditableDocument,
  wouldBreakWhere: number,
  affectedLineSet: Set<number>,
  partialSelectionStartOffset?: number
): number | false {
  const cursor = mirrorDoc.getTokenCursor(wouldBreakWhere);
  const token = cursor.getToken();

  if (token.type === 'close') {
    const startLine = cursor.line;
    const probe = cursor.clone();
    while (!probe.atEnd() && probe.line === startLine) {
      const tok = probe.getToken();
      if (tok.type === 'close') {
        const finder = probe.clone();
        if (
          !finder.backwardList() ||
          (partialSelectionStartOffset !== undefined &&
            finder.offsetStart < partialSelectionStartOffset) ||
          !affectedLineSet.has(finder.line)
        ) {
          return probe.offsetStart;
        }
      }
      probe.next();
    }
    return false;
  }

  const endCursor = cursor.clone();
  if (endCursor.forwardSexp(true, true, true)) {
    return affectedLineSet.has(endCursor.line) ? false : wouldBreakWhere;
  }

  return wouldBreakWhere;
}

type OffsetRange = [number, number];

function collectEnclosingFormRanges(
  document: vscode.TextDocument,
  lineNumbers: number[],
  useCurrentForm = false
): OffsetRange[] {
  const uniqueRanges = new Map<string, OffsetRange>();

  for (const lineNum of lineNumbers) {
    const line = document.lineAt(lineNum);
    const position = new vscode.Position(lineNum, line.firstNonWhitespaceCharacterIndex);
    let range: OffsetRange | undefined;

    if (useCurrentForm) {
      // For delimiter lines (closing parens on their own line), use rangeForList(1)
      // to find the form being closed rather than the parent form
      const mirrorDoc = docMirror.getDocument(document);
      const offset = document.offsetAt(position);
      const cursor = mirrorDoc.getTokenCursor(offset);
      const listRange = cursor.rangeForList(1);
      if (listRange) {
        range = listRange;
      }
    }

    if (!range) {
      const enclosing =
        select.getEnclosingFormSelection(document, position) ??
        select.getFormSelection(document, position, false);
      if (enclosing) {
        range = [document.offsetAt(enclosing.start), document.offsetAt(enclosing.end)];
      }
    }

    if (!range) {
      continue;
    }
    uniqueRanges.set(`${range[0]}:${range[1]}`, range);
  }

  return Array.from(uniqueRanges.values()).sort((a, b) => b[0] - a[0]);
}

/**
 * Applies formatting edits for each range sequentially (descending by offset)
 * because formatting one range may shift positions in later ranges.
 */
async function reformatRanges(
  editor: vscode.TextEditor,
  ranges: OffsetRange[],
  extraCljfmtOptions?: format.CljfmtOptionOverrides
) {
  for (let i = 0; i < ranges.length; i++) {
    const [start, end] = ranges[i];
    const range = new vscode.Range(
      editor.document.positionAt(start),
      editor.document.positionAt(end)
    );
    const edits = format.formatRangeEdits(editor.document, range, extraCljfmtOptions);
    const isLast = i === ranges.length - 1;

    if (!edits || edits.length === 0) {
      if (isLast) {
        await editor.edit(() => undefined, { undoStopBefore: false, undoStopAfter: true });
      }
      continue;
    }

    await editor.edit(
      (editBuilder) => {
        for (const edit of edits) {
          editBuilder.replace(edit.range, edit.newText);
        }
      },
      {
        undoStopBefore: false,
        undoStopAfter: isLast,
      }
    );
  }
}

/**
 * Reformats the enclosing forms for the given lines.
 */
async function reformatEnclosingFormsForLines(
  editor: vscode.TextEditor,
  affectedLineNumbers: number[],
  extraCljfmtOptions?: format.CljfmtOptionOverrides,
  useCurrentForm = false
) {
  const ranges = collectEnclosingFormRanges(editor.document, affectedLineNumbers, useCurrentForm);
  if (ranges.length === 0) {
    await editor.edit(() => undefined, { undoStopBefore: false, undoStopAfter: true });
    return;
  }

  await reformatRanges(editor, ranges, extraCljfmtOptions);
}

/**
 * Adds or removes comment prefixes on the given lines.
 * When uncommenting, removes any leading semicolon sequence plus trailing spaces.
 * When commenting, inserts `;; `.
 */
async function updateLineComments(
  editor: vscode.TextEditor,
  affectedLineNumbers: number[],
  shouldUncomment: boolean,
  candidatesMap: Map<number, number[]>
) {
  const descendingLineNumbers = affectedLineNumbers.sort((a, b) => b - a);

  await editor.edit(
    (editBuilder) => {
      for (const lineNum of descendingLineNumbers) {
        const line = editor.document.lineAt(lineNum);
        const lineText = line.text;

        if (shouldUncomment) {
          const candidates = candidatesMap.get(lineNum) ?? [];
          const removalStart = findCommentPrefixStart(lineText, candidates);
          if (removalStart === undefined) {
            continue;
          }
          const removalEnd = calculateCommentPrefixRemovalEnd(lineText, removalStart);
          if (removalEnd === undefined) {
            continue;
          }

          editBuilder.delete(
            new vscode.Range(
              new vscode.Position(lineNum, removalStart),
              new vscode.Position(lineNum, removalEnd)
            )
          );
        } else {
          editBuilder.insert(
            new vscode.Position(lineNum, line.firstNonWhitespaceCharacterIndex),
            ';; '
          );
        }
      }
    },
    {
      undoStopBefore: true,
      undoStopAfter: false,
    }
  );
}

/**
 * Adds or removes line-comment prefixes, then reformats enclosing forms to
 * restore canonical Clojure indentation. Used for multi-selection commenting
 * and for all uncommenting.
 */
async function toggleCommentsThenReformatEnclosingForms(
  editor: vscode.TextEditor,
  affectedLineNumbers: number[],
  shouldUncomment: boolean,
  candidatesMap: Map<number, number[]>
) {
  await updateLineComments(editor, affectedLineNumbers, shouldUncomment, candidatesMap);
  await reformatEnclosingFormsForLines(editor, affectedLineNumbers);
}

/**
 * Toggle line comments with Clojure-aware indentation.
 *
 * - For a single selection (cursor or range), comments are inserted structurally
 *   using paredit structural analysis to preserve delimiter balance, then
 *   enclosing forms are reformatted.
 * - For multiple selections or when uncommenting, adds/removes `;; ` prefixes
 *   and reformats enclosing forms.
 */
export async function toggleLineCommentCommand() {
  const document = util.tryToGetDocument({});
  if (!document || document.languageId !== 'clojure') {
    return;
  }

  const editor = util.getActiveTextEditor();
  if (!editor) {
    return;
  }

  const affectedLineNumbers = getAffectedLineNumbers(editor, document.lineCount);
  if (affectedLineNumbers.length === 0) {
    return;
  }

  const candidatesMap = new Map<number, number[]>();
  for (const lineNum of affectedLineNumbers) {
    const line = document.lineAt(lineNum);
    candidatesMap.set(
      lineNum,
      commentCandidatePositions(line.firstNonWhitespaceCharacterIndex, lineNum, editor.selections)
    );
  }

  const allNonEmptyLinesCommented = areAllNonEmptyTargetLinesCommented(
    document,
    affectedLineNumbers,
    candidatesMap
  );

  const isSingleSelection = editor.selections.length === 1;
  if (!allNonEmptyLinesCommented && isSingleSelection) {
    await applyStructuralCommentsToSingleSelectionLines(editor, affectedLineNumbers);
    return;
  }

  await toggleCommentsThenReformatEnclosingForms(
    editor,
    affectedLineNumbers,
    allNonEmptyLinesCommented,
    candidatesMap
  );
}

export function replace(
  editor: vscode.TextEditor,
  range: vscode.Range,
  newText: string,
  options = {}
) {
  const document = editor.document;
  const mirrorDoc: EditableDocument = docMirror.getDocument(document);
  return mirrorDoc.model.edit(
    [
      new ModelEdit('changeRange', [
        document.offsetAt(range.start),
        document.offsetAt(range.end),
        newText,
      ]),
    ],
    {
      ...{
        undoStopBefore: true,
      },
      ...options,
    }
  );
}

export function prettyPrintReplaceCurrentForm(
  options = { map: { 'sort?': false, 'comma?': false } }
) {
  const editor = util.getActiveTextEditor();
  const document = editor.document;
  const selection = editor.selections[0];
  const range = selection.isEmpty
    ? select.getFormSelection(document, selection.active, false)
    : selection;
  const text = document.getText(range);
  const result = printer.prettyPrint(text, options);
  if (result.error) {
    void vscode.window.showErrorMessage(`${result.error}`, 'OK');
    return;
  }
  return replace(editor, range, result.value);
}
