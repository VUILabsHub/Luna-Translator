import { apiURL } from './apiBase'
import { apiFetch } from './apiFetch'
import { consumerFetch } from './consumerSession'

// Exhibition Product history uses consumer tokens; Eval Admin keeps its own login.
export function historyFetch(path: string, init?: RequestInit): Promise<Response> {
  return /^\/api\/product\/history(?:[/?]|$)/.test(apiURL(path))
    ? consumerFetch(path, init)
    : apiFetch(path, init)
}
