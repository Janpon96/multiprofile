import { DomainError } from '@multiprofile/domain';

export interface TextPatchPayload {
  startOffset: number;
  endOffset: number;
  insertedText: string;
  expectedBaseline: string;
}

export class VietnameseImeComposer {
  public static computeTextPatch(
    oldValue: string,
    newValue: string,
    selectionStart: number = 0
  ): TextPatchPayload {
    let startOffset = 0;
    while (
      startOffset < oldValue.length &&
      startOffset < newValue.length &&
      oldValue[startOffset] === newValue[startOffset]
    ) {
      startOffset++;
    }

    let oldEnd = oldValue.length - 1;
    let newEnd = newValue.length - 1;

    while (
      oldEnd >= startOffset &&
      newEnd >= startOffset &&
      oldValue[oldEnd] === newValue[newEnd]
    ) {
      oldEnd--;
      newEnd--;
    }

    const insertedText = newValue.substring(startOffset, newEnd + 1);
    const endOffset = oldEnd + 1;

    return {
      startOffset,
      endOffset,
      insertedText,
      expectedBaseline: oldValue
    };
  }

  public static applyTextPatch(
    currentFieldValue: string,
    patch: TextPatchPayload
  ): string {
    if (currentFieldValue !== patch.expectedBaseline) {
      throw new DomainError(
        'TEXT_BASELINE_MISMATCH',
        `Follower field baseline mismatch. Expected: "${patch.expectedBaseline}", Actual: "${currentFieldValue}"`
      );
    }

    const before = currentFieldValue.substring(0, patch.startOffset);
    const after = currentFieldValue.substring(patch.endOffset);
    return before + patch.insertedText + after;
  }
}
