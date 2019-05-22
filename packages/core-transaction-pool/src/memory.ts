import { app } from "@arkecosystem/core-container";
import { State } from "@arkecosystem/core-interfaces";
import { Enums, Interfaces, Utils } from "@arkecosystem/crypto";
import assert from "assert";

export class Memory {
    /**
     * An array of all transactions, possibly sorted by fee (highest fee first).
     * We use lazy sorting:
     * - insertion just appends at the end, complexity: O(1) + flag it as unsorted
     * - deletion removes by using splice(), complexity: O(n) + flag it as unsorted
     * - lookup sorts if it is not sorted, complexity: O(n*log(n) + flag it as sorted
     */
    private all: Interfaces.ITransaction[] = [];
    private allIsSorted: boolean = true;
    private byId: { [key: string]: Interfaces.ITransaction } = {};
    private bySender: { [key: string]: Set<Interfaces.ITransaction> } = {};
    private byType: { [key: number]: Set<Interfaces.ITransaction> } = {};
    /**
     * Contains only transactions that have expiration, possibly sorted by height (lower first).
     */
    private byExpiration: Interfaces.ITransaction[] = [];
    private byExpirationIsSorted: boolean = true;
    private readonly dirty: { added: Set<string>; removed: Set<string> } = {
        added: new Set(),
        removed: new Set(),
    };

    public allSortedByFee(): Interfaces.ITransaction[] {
        if (!this.allIsSorted) {
            this.sortAll();
            this.allIsSorted = true;
        }

        return this.all;
    }

    public getExpired(maxTransactionAge: number): Interfaces.ITransaction[] {
        if (!this.byExpirationIsSorted) {
            this.byExpiration.sort((a, b) => a.data.expiration - b.data.expiration);
            this.byExpirationIsSorted = true;
        }

        const currentHeight: number = this.currentHeight();
        const transactions: Interfaces.ITransaction[] = [];

        for (const transaction of this.byExpiration) {
            if (transaction.data.expiration > currentHeight) {
                break;
            }

            transactions.push(transaction);
        }

        return transactions;
    }

    public getInvalid(): Interfaces.ITransaction[] {
        const transactions: Interfaces.ITransaction[] = [];

        for (const transaction of Object.values(this.byId)) {
            const { error } = transaction.verifySchema();

            if (error) {
                transactions.push(transaction);
            }
        }

        return transactions;
    }

    public getById(id: string): Interfaces.ITransaction | undefined {
        if (this.byId[id] === undefined) {
            return undefined;
        }

        return this.byId[id];
    }

    public getByType(type: number): Set<Interfaces.ITransaction> {
        if (this.byType[type] !== undefined) {
            return this.byType[type];
        }

        return new Set();
    }

    public getBySender(senderPublicKey: string): Set<Interfaces.ITransaction> {
        if (this.bySender[senderPublicKey] !== undefined) {
            return this.bySender[senderPublicKey];
        }

        return new Set();
    }

    public remember(transaction: Interfaces.ITransaction, maxTransactionAge: number, databaseReady?: boolean): void {
        assert.strictEqual(this.byId[transaction.id], undefined);

        this.all.push(transaction);
        this.allIsSorted = false;

        this.byId[transaction.id] = transaction;

        const sender: string = transaction.data.senderPublicKey;
        const type: number = transaction.type;

        if (this.bySender[sender] === undefined) {
            // First transaction from this sender, create a new Set.
            this.bySender[sender] = new Set([transaction]);
        } else {
            // Append to existing transaction ids for this sender.
            this.bySender[sender].add(transaction);
        }

        if (this.byType[type] === undefined) {
            // First transaction of this type, create a new Set.
            this.byType[type] = new Set([transaction]);
        } else {
            // Append to existing transaction ids for this type.
            this.byType[type].add(transaction);
        }

        if (type !== Enums.TransactionTypes.TimelockTransfer) {
            if (transaction.data.expiration > 0) {
                this.byExpiration.push(transaction);
                this.byExpirationIsSorted = false;
            }
        }

        if (!databaseReady) {
            if (this.dirty.removed.has(transaction.id)) {
                // If the transaction has been already in the pool and has been removed
                // and the removal has not propagated to disk yet, just wipe it from the
                // list of removed transactions, so that the old copy stays on disk.
                this.dirty.removed.delete(transaction.id);
            } else {
                this.dirty.added.add(transaction.id);
            }
        }
    }

    public forget(id: string, senderPublicKey?: string): void {
        if (this.byId[id] === undefined) {
            return;
        }

        if (senderPublicKey === undefined) {
            senderPublicKey = this.byId[id].data.senderPublicKey;
        }

        const transaction: Interfaces.ITransaction = this.byId[id];
        const type: number = this.byId[id].type;

        // XXX worst case: O(n)
        let i: number = this.byExpiration.findIndex(e => e.id === id);
        if (i !== -1) {
            this.byExpiration.splice(i, 1);
        }

        this.bySender[senderPublicKey].delete(transaction);
        if (this.bySender[senderPublicKey].size === 0) {
            delete this.bySender[senderPublicKey];
        }

        this.byType[type].delete(transaction);
        if (this.byType[type].size === 0) {
            delete this.byType[type];
        }

        delete this.byId[id];

        i = this.all.findIndex(e => e.id === id);
        assert.notStrictEqual(i, -1);
        this.all.splice(i, 1);
        this.allIsSorted = false;

        if (this.dirty.added.has(id)) {
            // This transaction has been added and deleted without data being synced
            // to disk in between, so it will never touch the disk, just remove it
            // from the added list.
            this.dirty.added.delete(id);
        } else {
            this.dirty.removed.add(id);
        }
    }

    public has(id: string): boolean {
        return this.byId[id] !== undefined;
    }

    public flush(): void {
        this.all = [];
        this.allIsSorted = true;
        this.byId = {};
        this.bySender = {};
        this.byType = {};
        this.byExpiration = [];
        this.byExpirationIsSorted = true;
        this.dirty.added.clear();
        this.dirty.removed.clear();
    }

    public count(): number {
        return this.all.length;
    }

    public countDirty(): number {
        return this.dirty.added.size + this.dirty.removed.size;
    }

    public pullDirtyAdded(): Interfaces.ITransaction[] {
        const added: Interfaces.ITransaction[] = [];

        for (const id of this.dirty.added) {
            added.push(this.byId[id]);
        }

        this.dirty.added.clear();

        return added;
    }

    public pullDirtyRemoved(): string[] {
        const removed: string[] = Array.from(this.dirty.removed);
        this.dirty.removed.clear();

        return removed;
    }

    /**
     * Sort `this.all` by fee (highest fee first) with the exception that transactions
     * from the same sender must be ordered lowest `nonce` first.
     */
    private sortAll(): void {
        this.all.sort((a, b) => {
            const feeA: Utils.BigNumber = a.data.fee;
            const feeB: Utils.BigNumber = b.data.fee;

            if (feeA.isGreaterThan(feeB)) {
                return -1;
            }

            if (feeA.isLessThan(feeB)) {
                return 1;
            }

            if (a.data.expiration > 0 && b.data.expiration > 0) {
                return a.data.expiration - b.data.expiration;
            }

            return 0;
        });

        const indexBySender = {};
        for (let i = 0; i < this.all.length; i++) {
            const transaction: Interfaces.ITransaction = this.all[i];

            if (transaction.data.version < 2) {
                continue;
            }

            const sender: string = transaction.data.senderPublicKey;
            if (indexBySender[sender] === undefined) {
                indexBySender[sender] = [];
            }
            indexBySender[sender].push(i);

            let nMoved = 0;

            for (let j = 0; j < indexBySender[sender].length - 1; j++) {
                const prevIndex: number = indexBySender[sender][j];
                if (this.all[i].data.nonce.isLessThan(this.all[prevIndex].data.nonce)) {
                    const newIndex = i + 1 + nMoved;
                    this.all.splice(newIndex, 0, this.all[prevIndex]);
                    this.all[prevIndex] = undefined;

                    indexBySender[sender][j] = newIndex;

                    nMoved++;
                }
            }

            if (nMoved > 0) {
                indexBySender[sender].sort((a, b) => a - b);
            }

            i += nMoved;
        }

        this.all = this.all.filter(t => t !== undefined);
    }

    private currentHeight(): number {
        return app
            .resolvePlugin<State.IStateService>("state")
            .getStore()
            .getLastHeight();
    }
}