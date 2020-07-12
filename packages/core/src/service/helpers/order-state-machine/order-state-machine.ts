import { Injectable } from '@nestjs/common';
import { HistoryEntryType } from '@vendure/common/lib/generated-types';
import { isObservable } from 'rxjs';

import { RequestContext } from '../../../api/common/request-context';
import { IllegalOperationError } from '../../../common/error/errors';
import { FSM, StateMachineConfig, Transitions } from '../../../common/finite-state-machine';
import { ConfigService } from '../../../config/config.service';
import { Order } from '../../../entity/order/order.entity';
import { HistoryService } from '../../services/history.service';
import { PromotionService } from '../../services/promotion.service';
import { StockMovementService } from '../../services/stock-movement.service';

import { OrderState, orderStateTransitions, OrderTransitionData } from './order-state';

@Injectable()
export class OrderStateMachine {
    private readonly config: StateMachineConfig<OrderState, OrderTransitionData>;
    private readonly initialState: OrderState = 'AddingItems';

    constructor(
        private configService: ConfigService,
        private stockMovementService: StockMovementService,
        private historyService: HistoryService,
        private promotionService: PromotionService,
    ) {
        this.config = this.initConfig();
    }

    getInitialState(): OrderState {
        return this.initialState;
    }

    canTransition(currentState: OrderState, newState: OrderState): boolean {
        return new FSM(this.config, currentState).canTransitionTo(newState);
    }

    getNextStates(order: Order): OrderState[] {
        const fsm = new FSM(this.config, order.state);
        return fsm.getNextStates();
    }

    async transition(ctx: RequestContext, order: Order, state: OrderState) {
        const fsm = new FSM(this.config, order.state);
        await fsm.transitionTo(state, { ctx, order });
        order.state = state;
    }

    /**
     * Specific business logic to be executed on Order state transitions.
     */
    private onTransitionStart(fromState: OrderState, toState: OrderState, data: OrderTransitionData) {
        if (toState === 'ArrangingPayment') {
            if (data.order.lines.length === 0) {
                return `error.cannot-transition-to-payment-when-order-is-empty`;
            }
            if (!data.order.customer) {
                return `error.cannot-transition-to-payment-without-customer`;
            }
        }
    }

    /**
     * Specific business logic to be executed after Order state transition completes.
     */
    private async onTransitionEnd(fromState: OrderState, toState: OrderState, data: OrderTransitionData) {
        if (toState === 'PaymentAuthorized' || toState === 'PaymentSettled') {
            data.order.active = false;
            data.order.orderPlacedAt = new Date();
            await this.stockMovementService.createSalesForOrder(data.order);
            await this.promotionService.addPromotionsToOrder(data.order);
        }
        if (toState === 'Cancelled') {
            data.order.active = false;
        }
        await this.historyService.createHistoryEntryForOrder({
            orderId: data.order.id,
            type: HistoryEntryType.ORDER_STATE_TRANSITION,
            ctx: data.ctx,
            data: {
                from: fromState,
                to: toState,
            },
        });
    }

    private initConfig(): StateMachineConfig<OrderState, OrderTransitionData> {
        const {
            transitions,
            onTransitionStart,
            onTransitionEnd,
            onTransitionError,
        } = this.configService.orderOptions.process;

        const allTransitions = this.mergeTransitionDefinitions(orderStateTransitions, transitions);
        const orderProcessStrategy = this.configService.orderOptions.orderProcessStrategy;

        return {
            transitions: allTransitions,
            onTransitionStart: async (fromState, toState, data) => {
                const result =
                    typeof orderProcessStrategy.onTransitionStart === 'function'
                        ? orderProcessStrategy.onTransitionStart(fromState, toState, data)
                        : typeof onTransitionStart === 'function'
                        ? onTransitionStart(fromState, toState, data)
                        : undefined;
                const resolvedResult = await (isObservable(result) ? await result.toPromise() : result);
                if (resolvedResult === false || typeof resolvedResult === 'string') {
                    return resolvedResult;
                }
                return this.onTransitionStart(fromState, toState, data);
            },
            onTransitionEnd: async (fromState, toState, data) => {
                if (typeof orderProcessStrategy.onTransitionEnd === 'function') {
                    await orderProcessStrategy.onTransitionEnd(fromState, toState, data);
                } else if (typeof onTransitionEnd === 'function') {
                    onTransitionEnd(fromState, toState, data);
                }
                return this.onTransitionEnd(fromState, toState, data);
            },
            onError: async (fromState, toState, message) => {
                if (typeof orderProcessStrategy.onTransitionError === 'function') {
                    await orderProcessStrategy.onTransitionError(fromState, toState, message);
                } else if (typeof onTransitionError === 'function') {
                    onTransitionError(fromState, toState, message);
                }
                throw new IllegalOperationError(message || 'error.cannot-transition-order-from-to', {
                    fromState,
                    toState,
                });
            },
        };
    }

    /**
     * Merge any custom transition definitions into the default transitions for the Order process.
     */
    private mergeTransitionDefinitions<T extends string>(
        defaultTranstions: Transitions<T>,
        customTranstitions?: any,
    ): Transitions<T> {
        if (!customTranstitions) {
            return defaultTranstions;
        }
        const merged = defaultTranstions;
        for (const k of Object.keys(customTranstitions)) {
            const key = k as T;
            if (merged.hasOwnProperty(key)) {
                merged[key].to = merged[key].to.concat(customTranstitions[key].to);
            } else {
                merged[key] = customTranstitions[key];
            }
        }
        return merged;
    }
}
