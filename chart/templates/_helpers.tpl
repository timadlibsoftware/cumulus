{{- define "cumulus.labels" -}}
app.kubernetes.io/name: cumulus
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" }}
{{- end -}}

{{/* Orchestrator pods. Never `app.kubernetes.io/managed-by: cumulus`: that label marks worker pods (C-4). */}}
{{- define "cumulus.selectorLabels" -}}
app.kubernetes.io/name: cumulus
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/component: orchestrator
{{- end -}}

{{/* ADR-0003: deploy only immutable tags. Usage: include "cumulus.image" (list "name" .Values.image) */}}
{{- define "cumulus.image" -}}
{{- $name := index . 0 -}}
{{- $image := index . 1 -}}
{{- $tag := toString $image.tag -}}
{{- if or (empty $tag) (eq $tag "latest") (hasPrefix "sha-" $tag) -}}
{{- fail (printf "%s image needs an immutable GITHUB_RUN_ID tag, got %q" $name $tag) -}}
{{- end -}}
{{- printf "%s:%s" $image.repository $tag -}}
{{- end -}}

{{- define "cumulus.externalSecretData" -}}
- secretKey: {{ .name }}
  remoteRef:
    key: {{ .key }}
    conversionStrategy: Default
    decodingStrategy: None
    metadataPolicy: None
{{- end -}}
