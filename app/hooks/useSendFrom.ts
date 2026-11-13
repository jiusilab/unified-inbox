// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { useQuery } from "@tanstack/react-query";
import { queryKeys } from "~/queries/keys";
import api from "~/services/api";

/** Addresses outbound mail may be sent from (SEND_FROM on the Worker). */
export function useSendFrom(): string[] {
	const { data } = useQuery({
		queryKey: queryKeys.config,
		queryFn: () => api.getConfig(),
		staleTime: Infinity,
	});
	return data?.sendFrom ?? [];
}
