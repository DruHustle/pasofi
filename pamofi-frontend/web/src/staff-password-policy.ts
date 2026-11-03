import { ZxcvbnFactory } from '@zxcvbn-ts/core';
import * as common from '@zxcvbn-ts/language-common';
import * as english from '@zxcvbn-ts/language-en';

const estimator = new ZxcvbnFactory({ dictionary: { ...common.dictionary, ...english.dictionary }, graphs: common.adjacencyGraphs });
// The estimate runs locally; passwords are never sent to a strength service.
export function strongStaffPassword(password: string, email: string, name = ''): boolean {
  const length = [...password].length;
  if (length < 18 || length > 128 || !/\S/.test(password) || /[\r\n]/.test(password)) return false;
  return estimator.check(password, [email, email.split('@')[0], name, 'pamofi', 'onesa']).score >= 3;
}
