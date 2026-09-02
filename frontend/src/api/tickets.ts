import type { Ticket, TicketMessage } from '../types/ticket'
import { apiFetch } from './client'

const BACKEND_URL = import.meta.env.VITE_BACKEND_URL || 'http://localhost:4000'

export function escalateTicket(sessionId: string, question: string) {
  return fetch(`${BACKEND_URL}/api/tickets/escalate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId, question }),
  }).then(res => res.json())
}


export function getInbox() {
  return apiFetch<{ tickets: Ticket[] }>('/api/tickets/inbox')
}

export function getActiveTickets() {
  return apiFetch<{ tickets: Ticket[] }>('/api/tickets/active')
}

export function getResolvedTickets() {
  return apiFetch<{ tickets: Ticket[] }>('/api/tickets/resolved')
}

export function claimTicket(ticketId: string) {
  return apiFetch<{ ticket: Ticket }>(`/api/tickets/${ticketId}/claim`, {
    method: 'POST',
  })
}

export function getTicketMessages(ticketId: string) {
  return apiFetch<{ messages: TicketMessage[] }>(`/api/tickets/${ticketId}/messages`)
}

export function sendTicketMessage(ticketId: string, content: string, senderRole: string) {
  return apiFetch<{ message: TicketMessage }>(`/api/tickets/${ticketId}/messages`, {
    method: 'POST',
    body: JSON.stringify({ content, senderRole }),
  })
}

export function resolveTicket(ticketId: string) {
  return apiFetch<{ ticket: Ticket }>(`/api/tickets/${ticketId}/resolve`, {
    method: 'POST',
  })
}

export function getTicketContext(ticketId: string) {
  return apiFetch<{ history: { role: string; content: string; created_at: string }[] }>(
    `/api/tickets/${ticketId}/context`
  )
}