# Stage 1: Build and publish .NET application
FROM mcr.microsoft.com/dotnet/sdk:10.0 AS dotnet-builder
WORKDIR /src

# Copy solution and project files
COPY ["MyDevToolsApp/MyDevTools.Site/MyDevTools.Site.csproj", "MyDevToolsApp/MyDevTools.Site/"]
RUN dotnet restore "MyDevToolsApp/MyDevTools.Site/MyDevTools.Site.csproj"

# Copy everything else (including pre-built wwwroot/wasm)
COPY . .

WORKDIR "/src/MyDevToolsApp/MyDevTools.Site"
RUN dotnet publish "MyDevTools.Site.csproj" -c Release -o /app/publish /p:UseAppHost=false

# Stage 2: Final runtime image
FROM mcr.microsoft.com/dotnet/aspnet:10.0 AS final
WORKDIR /app
EXPOSE 8080
EXPOSE 8081

COPY --from=dotnet-builder /app/publish .

# Environment variables for Blazor
ENV ASPNETCORE_URLS=http://+:8080
ENTRYPOINT ["dotnet", "MyDevTools.Site.dll"]