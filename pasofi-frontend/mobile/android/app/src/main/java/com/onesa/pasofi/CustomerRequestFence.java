package com.onesa.pasofi;

/** Request generations are captured when accepted, before worker scheduling. */
final class CustomerRequestFence {
    static final class Ticket {
        final String requestId;
        final long generation;
        final boolean changesIdentity;
        boolean cancelled;
        Ticket(String requestId, long generation, boolean changesIdentity) { this.requestId = requestId; this.generation = generation; this.changesIdentity = changesIdentity; }
    }
    private long generation;
    private Ticket identity;
    private boolean closed;

    synchronized Ticket accept(String requestId, boolean changesIdentity) {
        // A request accepted during recovery must not acquire the new generation
        // and later execute old UI intent under the replacement account's cookie.
        if (closed || identity != null) throw new IllegalStateException("session_change_in_progress");
        if (changesIdentity) generation++;
        Ticket ticket = new Ticket(requestId, generation, changesIdentity);
        if (changesIdentity) identity = ticket;
        return ticket;
    }
    synchronized boolean current(Ticket ticket) { return !closed && !ticket.cancelled && ticket.generation == generation; }
    synchronized void cancel(Ticket ticket) { ticket.cancelled = true; }
    synchronized void finish(Ticket ticket) { if (identity == ticket) identity = null; }
    synchronized void reset() { if (!closed) { generation++; identity = null; } }
    synchronized void close() { closed = true; generation++; }
}
