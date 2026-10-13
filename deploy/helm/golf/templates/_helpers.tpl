{{- define "golf.fullname" -}}
{{- printf "%s-golf" .Release.Name -}}
{{- end -}}
{{- define "golf.labels" -}}
app.kubernetes.io/name: golf
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | quote }}
{{- end -}}
{{- define "golf.selector" -}}
app.kubernetes.io/name: golf
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}
{{- define "golf.image" -}}
{{- if .digest -}}{{ .repository }}@{{ .digest }}{{- else -}}{{ .repository }}:{{ .tag }}{{- end -}}
{{- end -}}
{{- define "golf.forgejoURL" -}}
{{- if .Values.forgejo.enabled -}}http://{{ include "golf.fullname" . }}-forgejo:3000{{- else -}}{{ trimSuffix "/" .Values.forgejo.externalURL }}{{- end -}}
{{- end -}}
{{- define "golf.postgresHost" -}}
{{- if .Values.postgresql.enabled -}}{{ include "golf.fullname" . }}-postgres:5432{{- else -}}{{ .Values.forgejo.database.host }}{{- end -}}
{{- end -}}
{{- define "golf.containerSecurity" -}}
allowPrivilegeEscalation: false
readOnlyRootFilesystem: true
capabilities:
  drop: [ALL]
{{- end -}}
{{- define "golf.dnsEgress" -}}
- to:
    - namespaceSelector:
        matchLabels:
          kubernetes.io/metadata.name: {{ .Values.networkPolicy.dnsNamespace | quote }}
  ports:
    - {protocol: UDP, port: 53}
    - {protocol: TCP, port: 53}
{{- end -}}
