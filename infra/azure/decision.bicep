// Creates (or updates) an AIServices account in swedencentral and a Microsoft-Decision-1 deployment.
// For an account that already exists, use decision-existing.bicep instead so its settings are not overwritten.
targetScope = 'resourceGroup'

@description('Azure region. Restricted to swedencentral: Microsoft-Decision-1 DataZoneStandard (EU data zone).')
@allowed([
  'swedencentral'
])
param location string = 'swedencentral'

@description('Globally unique AIServices account name; also used as the custom subdomain of the endpoint.')
@minLength(2)
@maxLength(64)
param accountName string

@description('Deployment name sent as "model" in requests. Must NOT be Microsoft-Decision-1 (reserved word).')
@minLength(1)
@maxLength(64)
param deploymentName string = 'decision-1'

@description('Requests per minute. For this model 1 capacity unit = 1 request per minute.')
@minValue(1)
@maxValue(1000)
param capacityRpm int = 300

@description('Optional resource tags.')
param tags object = {}

resource account 'Microsoft.CognitiveServices/accounts@2026-07-01' = {
  name: accountName
  location: location
  kind: 'AIServices'
  tags: tags
  sku: {
    name: 'S0'
  }
  identity: {
    type: 'SystemAssigned'
  }
  properties: {
    customSubDomainName: accountName
    publicNetworkAccess: 'Enabled'
    // The Cloudflare Worker authenticates with the api-key header, so local auth must stay enabled.
    disableLocalAuth: false
    allowProjectManagement: true
  }
}

resource decision 'Microsoft.CognitiveServices/accounts/deployments@2026-07-01' = {
  parent: account
  name: deploymentName
  sku: {
    name: 'DataZoneStandard'
    capacity: capacityRpm
  }
  properties: {
    model: {
      format: 'Microsoft'
      name: 'Microsoft-Decision-1'
      version: '1'
    }
    // Keep behavior stable for calibration; plan the move before version 1 retires on 2027-02-04.
    versionUpgradeOption: 'NoAutoUpgrade'
  }
}

@description('Value for the AZURE_DECISION_ENDPOINT secret.')
output decisionEndpoint string = 'https://${accountName}.services.ai.azure.com'

@description('Value for the AZURE_DECISION_DEPLOYMENT secret.')
output deploymentName string = decision.name
