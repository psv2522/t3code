import { tokenizeCode, type TokenizeRequest } from "./shikiTokenizer";

export function tokenizeOnWorker(request: TokenizeRequest, signal?: AbortSignal) {
  return tokenizeCode(request, () => signal?.aborted ?? false);
}
