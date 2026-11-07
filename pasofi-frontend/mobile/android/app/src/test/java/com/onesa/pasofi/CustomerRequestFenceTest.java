package com.onesa.pasofi;

import static org.junit.Assert.*;
import org.junit.Test;

public class CustomerRequestFenceTest {
    private static void rejects(Runnable work) { try { work.run(); fail("Expected pending or closed generation rejection"); } catch (IllegalStateException expected) {} }

    @Test public void queuedAccountAMutationCannotExecuteAfterRecoveryChangesTheCookie() {
        CustomerRequestFence fence = new CustomerRequestFence();
        CustomerRequestFence.Ticket purchase = fence.accept("purchase-A", false);
        assertTrue(fence.current(purchase));
        CustomerRequestFence.Ticket recovery = fence.accept("recovery-B", true);
        assertFalse(fence.current(purchase)); assertTrue(fence.current(recovery));
        fence.finish(recovery);
        assertFalse(fence.current(purchase));
        assertTrue(fence.current(fence.accept("new-B-read", false)));
    }

    @Test public void accountARequestArrivingDuringPendingRecoveryCannotAcquireTheNewGeneration() {
        CustomerRequestFence fence = new CustomerRequestFence();
        CustomerRequestFence.Ticket recovery = fence.accept("recovery-B", true);
        rejects(() -> fence.accept("late-purchase-A", false));
        rejects(() -> fence.accept("another-recovery", true));
        fence.finish(recovery);
        assertTrue(fence.current(fence.accept("deliberate-B-request", false)));
    }

    @Test public void cancellationBlocksLateResponsesWithoutUnlockingAnUnfinishedIdentityOperation() {
        CustomerRequestFence fence = new CustomerRequestFence();
        CustomerRequestFence.Ticket logout = fence.accept("logout", true);
        fence.cancel(logout); assertFalse(fence.current(logout));
        rejects(() -> fence.accept("new-account", true));
        rejects(() -> fence.accept("ordinary-request", false));
        fence.finish(logout);
        assertTrue(fence.current(fence.accept("retry-read", false)));
    }

    @Test public void anOldCompletionCannotReleaseTheSlotOwnedByANewerIdentityTransition() {
        CustomerRequestFence fence = new CustomerRequestFence();
        CustomerRequestFence.Ticket first = fence.accept("first", true); fence.finish(first);
        CustomerRequestFence.Ticket second = fence.accept("second", true);
        fence.finish(first);
        rejects(() -> fence.accept("third", true)); rejects(() -> fence.accept("late-first-read", false));
        assertFalse(fence.current(first)); assertTrue(fence.current(second));
        fence.finish(second);
        assertTrue(fence.current(fence.accept("third", true)));
    }

    @Test public void closingThePluginInvalidatesEveryOutstandingResponseAndFutureRequest() {
        CustomerRequestFence fence = new CustomerRequestFence();
        CustomerRequestFence.Ticket read = fence.accept("read", false);
        fence.close(); assertFalse(fence.current(read));
        rejects(() -> fence.accept("after-close", false)); rejects(() -> fence.accept("after-close-auth", true));
        fence.finish(read); assertFalse(fence.current(read));
    }

    @Test public void webViewReloadInvalidatesOldRequestsWithoutReusingTheirGenerationOrIdentitySlot() {
        CustomerRequestFence fence = new CustomerRequestFence();
        CustomerRequestFence.Ticket old = fence.accept("old-page-recovery", true);
        fence.reset(); assertFalse(fence.current(old));
        CustomerRequestFence.Ticket fresh = fence.accept("new-page-recovery", true);
        assertTrue(fence.current(fresh));
        fence.finish(old);
        rejects(() -> fence.accept("old-page-completion-must-not-unlock", false));
        assertFalse(fence.current(old)); assertTrue(fence.current(fresh));
        fence.finish(fresh);
        assertTrue(fence.current(fence.accept("new-page-read", false)));
        fence.close(); fence.reset();
        rejects(() -> fence.accept("reset-must-not-reopen-destroyed-plugin", false));
    }
}
