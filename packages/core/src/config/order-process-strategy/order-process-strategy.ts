import { Observable } from 'rxjs';

import { StateMachineConfig, Transitions } from '../../common/finite-state-machine';
import { InjectableStrategy } from '../../common/types/injectable-strategy';
import { Order } from '../../entity/order/order.entity';
import { OrderState, OrderTransitionData } from '../../service/helpers/order-state-machine/order-state';

/**
 * @description
 * Defines custom states and transition logic for the order process state machine.
 *
 * @docsCategory Orders
 */
export interface OrderProcessStrategy<T extends string> extends InjectableStrategy {
    /**
     * @description
     * Define how the custom states fit in with the default order
     * state transitions.
     *
     */
    transitions?: Partial<Transitions<T | OrderState>>;
    /**
     * @description
     * Define logic to run before a state tranition takes place. Returning
     * false or a string will prevent the transition from going ahead.
     */
    onTransitionStart?(
        fromState: T,
        toState: T,
        data: { order: Order },
    ): boolean | string | void | Promise<boolean | string | void> | Observable<boolean | string | void>;
    /**
     * @description
     * Define logic to run after a state transition has taken place.
     */
    onTransitionEnd?(fromState: T, toState: T, data: { order: Order }): void | Promise<void>;
    /**
     * @description
     * Define a custom error handler function for transition errors.
     */
    onTransitionError?(fromState: T, toState: T, message?: string): void | Promise<void>;
}
