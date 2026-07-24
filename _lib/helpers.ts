export type RequestTemplate = {
    id: string;
    urlpath: string;
    requestInit: {
        method?: NonNullable<RequestInit["method"]>;
        headers?: Record<string, string>;
        body?: unknown;
    };
};



export function cloneJsonValue<T>(value: T): T {
    if (value === undefined) {
        return value;
    }
    return JSON.parse(JSON.stringify(value)) as T;
}

export function getRequestTemplate(typedRequestToSend: RequestTemplate[], templateId: string): RequestTemplate {
    const template = typedRequestToSend.find((entry) => entry.id === templateId);
    if (!template) {
        throw new Error(`Missing request template '${templateId}' in request_to_sent.jsonc`);
    }
    return template;
}

export function buildRequestInit(
    baseHeaders: Record<string, string>,
    template: RequestTemplate,
    bodyOverride?: unknown,
): RequestInit {
    const sourceBody = bodyOverride !== undefined ? bodyOverride : template.requestInit.body;
    const requestInit: RequestInit = {
        method: template.requestInit.method ?? "GET",
        headers: {
            ...baseHeaders,
            ...(template.requestInit.headers ?? {}),
        },
    };

    if (sourceBody !== undefined) {
        requestInit.body = JSON.stringify(sourceBody);
    }

    return requestInit;
}